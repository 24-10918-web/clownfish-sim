import { useState, useEffect, useRef, useCallback } from "react";

// ══════════════════════════════════════════════════════════════════════════════
// 공통 상수 및 파라미터
// ══════════════════════════════════════════════════════════════════════════════
const W = 860, H = 500;
const INIT_COUNT = 18;
const ANEMONE = { x: 430, y: 250 };
const SCENT_R = 130;  // 회피 감지 반경 (pH 무관 — 더 일찍 도망 시작)

// ── pH → 포식자 반응 bias (Munday 2009 / Dixson 2010) ────────────────────────
function getPredatorBias(pH) {
  if (pH >= 8.00) return -1.0;
  if (pH >= 7.92) { const t = (pH-7.92)/(8.00-7.92); return -1.0*t + (-0.1)*(1-t); }
  if (pH >= 7.80) { const t = (pH-7.80)/(7.92-7.80); return -0.1*t + 1.0*(1-t); }
  if (pH >= 7.60) { const t = (pH-7.60)/(7.80-7.60); return 1.0*t + 0.0*(1-t); }
  return 0.0;
}

// ── pH → 반응 지연 (latency, 프레임 수) ─────────────────────────────────────
// Nilsson et al. (2012): 산성화 개체의 위험 자극 반응 지연
// pH 8.15: 지연 0프레임, pH 7.8: ~25프레임, pH 7.6: ~55프레임
function getReactionLatency(pH) {
  if (pH >= 8.00) return 0;
  if (pH >= 7.80) { const t = (pH-7.80)/(8.00-7.80); return Math.round(0*t + 25*(1-t)); }
  if (pH >= 7.60) { const t = (pH-7.60)/(7.80-7.60); return Math.round(25*t + 55*(1-t)); }
  return 55;
}

function isNonResponsive(pH) { return pH <= 7.62; }

// ── pH → GABA-A 역전 확률 (Dixson 2010: pH 7.8에서 다수 개체가 역전) ──────────
// 개체군 내에서 포식자 냄새에 끌리도록 역전된 개체의 비율.
// 역전은 후각이 살아있어야 가능 → pH 7.7 부근에서 정점 후, 더 낮아지면
// 후각 마비(셧다운)가 늘어 역전 가능 개체가 오히려 감소한다.
// pH 8.0+ : 0% / pH 7.8 : 70% / pH 7.7 : 75%(정점) / pH 7.6 : 30%
function getReversalProbability(pH) {
  if (pH >= 8.00) return 0.0;
  if (pH >= 7.80) { const t = (pH-7.80)/(8.00-7.80); return 0.0*t + 0.70*(1-t); }   // 상승
  if (pH >= 7.70) { const t = (pH-7.70)/(7.80-7.70); return 0.70*t + 0.75*(1-t); }  // 정점
  if (pH >= 7.60) { const t = (pH-7.60)/(7.70-7.60); return 0.75*t + 0.30*(1-t); }  // 감소
  return 0.15; // 극산성: 대부분 셧다운, 소수만 역전
}

// ── pH → 후각 상실(셧다운) 확률 (Munday 2009: pH 7.6에서 후각 마비) ──────────
// 개체군 내에서 후각을 완전히 잃고 해류에 표류하는 개체의 비율
// pH 7.75+ : 0% / pH 7.70 : ~20% / pH 7.65 : ~55% / pH 7.60 : ~90%
function getShutdownProbability(pH) {
  if (pH >= 7.75) return 0.0;
  if (pH >= 7.70) { const t = (pH-7.70)/(7.75-7.70); return 0.0*t + 0.20*(1-t); }
  if (pH >= 7.60) { const t = (pH-7.60)/(7.70-7.60); return 0.20*t + 0.90*(1-t); }
  return 0.95; // pH 7.6 미만: 거의 전부 셧다운
}

// ── 노출 기간 효과 (Munday 2009: pH 7.8 노출 후 2~4일 뒤 행동 역전) ──────────
// 유효 pH = 노출일수에 따라 실제 pH 효과가 점진적으로 발현되는 pH 값.
// 노출 0일: 정상(8.15)에 가까움 → 시간 지날수록 설정 pH로 수렴.
// EXPOSURE_FULL_DAYS일 후 100% 발현. 정상 pH(>=8.0)는 노출 무관.
const EXPOSURE_FULL_DAYS = 2.5; // 완전 발현까지 걸리는 일수 (Munday: ~2일)
const DAYS_PER_SECOND = 0.7;    // 시뮬레이션 속도 (실시간 1초 = 0.7일)

function getEffectivePH(setPH, exposureDays) {
  if (setPH >= 8.00) return setPH;  // 정상 환경은 노출 무관
  // 발현 비율: 0일→0, FULL_DAYS일 이상→1 (S자 곡선)
  const raw = Math.min(1, exposureDays / EXPOSURE_FULL_DAYS);
  const progress = raw * raw * (3 - 2 * raw);  // smoothstep
  // 유효 pH = 8.15(정상)에서 setPH로 progress만큼 이동
  return 8.15 + (setPH - 8.15) * progress;
}

function phToCol(pH) {
  const t = Math.max(0, Math.min(1, (pH-7.60)/0.55));
  return "rgb("+Math.round(218-175*t)+","+Math.round(72+128*t)+","+Math.round(20+188*t)+")";
}
function phLabel(pH) {
  if (pH >= 8.00) return "정상 (현재 수준)";
  if (pH >= 7.92) return "약산성 (~700 ppm)";
  if (pH >= 7.80) return "GABAA 역전 (~850 ppm)";
  if (pH >= 7.70) return "강산성 (RCP 8.5, 2100)";
  return "극산성 — 신경계 셧다운";
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE 1 — 정착지 선택 시뮬레이션 (Munday 2009 실험 재현)
// 정착지 3종: 말미잘+Xanthostemon(좋음/유인) · Melaleuca(나쁨/기피→역전) · Grass(중립)
// pH 8.15: 좋은 곳만 선택  pH 7.8: 나쁜 곳에 역전 유인  pH 7.6: 무반응 표류
// ══════════════════════════════════════════════════════════════════════════════

// 정착지 정의 — 3×2 격자, 각 유형이 서로 다른 행·열에 한 번씩 (라틴방진)
// 순환 화면(토러스)에서 모든 정착지의 이웃 거리 분포가 동일 → 기하학적 편향 0
//   (143,125) good     (430,125) bad      (717,125) neutral
//   (143,375) bad      (430,375) neutral  (717,375) good
const SITES = [
  { id:0, x:143, y:125, type:'good',    label:'말미잘+Xanthostemon', emoji:'🌿', color:'#ff8c3a', glow:'rgba(255,140,50,0.22)' },
  { id:1, x:430, y:125, type:'bad',     label:'Melaleuca',           emoji:'🪵', color:'#8B5E3C', glow:'rgba(139,94,60,0.22)'  },
  { id:2, x:717, y:125, type:'neutral', label:'Grass',               emoji:'🌾', color:'#6a8a4a', glow:'rgba(106,138,74,0.18)' },
  { id:3, x:143, y:375, type:'bad',     label:'Melaleuca',           emoji:'🪵', color:'#8B5E3C', glow:'rgba(139,94,60,0.22)'  },
  { id:4, x:430, y:375, type:'neutral', label:'Grass',               emoji:'🌾', color:'#6a8a4a', glow:'rgba(106,138,74,0.18)' },
  { id:5, x:717, y:375, type:'good',    label:'말미잘+Xanthostemon', emoji:'🌿', color:'#ff8c3a', glow:'rgba(255,140,50,0.22)' },
];
const SITE_R = 28;        // 정착 판정 반경
const SITE_SCENT_R = 130; // 냄새 감지 반경

// ── 순환 화면(토러스) 거리 ──────────────────────────────────────────────────
// 벽이 없으므로 "중앙/모서리" 구분 자체가 사라짐 → 모든 정착지가 동등
function wrapD(d, size) {
  if (d >  size/2) d -= size;
  if (d < -size/2) d += size;
  return d;
}

// ── pH → 각 정착지 유형에 대한 선호도 ────────────────────────────────────────
// 출처: Munday et al. (2009) Fig.2 — 2채널 선택 수조 체류율
//   pref = 2*(체류율) - 1   [50%→0, 100%→+1, 0%→-1]
//
//   good    : 8.15 → 93%↑ 체류 (+0.90)   7.8 → 유인 유지하나 뚜렷이 약화 (+0.35)   7.6 → 0
//   bad     : 8.15 → 완전 회피 (-1.0)     7.8 → 80%↑ 체류 = 강한 역전 (+0.85)      7.6 → 0
//   neutral : 8.15 → 무반응 (+0.05)       7.8 → 선호 증가 (+0.30)                  7.6 → 0
function getSitePreference(siteType, pH) {
  if (isNonResponsive(pH)) return 0;   // pH <= 7.62: 모든 냄새 무반응 (표류)

  if (siteType === 'good') {
    if (pH >= 8.00) return 0.90;
    if (pH >= 7.80) { const t=(pH-7.80)/(8.00-7.80); return 0.90*t + 0.35*(1-t); }
    if (pH >= 7.60) { const t=(pH-7.60)/(7.80-7.60); return 0.35*t + 0.00*(1-t); }
    return 0;
  }

  if (siteType === 'bad') {
    if (pH >= 8.00) return -1.00;
    // 8.00 → 7.92: 회피가 급격히 무너짐
    if (pH >= 7.92) { const t=(pH-7.92)/(8.00-7.92); return -1.00*t + (-0.15)*(1-t); }
    // 7.92 → 7.80: 부호 역전 (GABA-A 반전)
    if (pH >= 7.80) { const t=(pH-7.80)/(7.92-7.80); return -0.15*t +  0.85*(1-t); }
    // 7.80 → 7.60: 역전 유인이 후각 마비로 서서히 소멸
    if (pH >= 7.60) { const t=(pH-7.60)/(7.80-7.60); return  0.85*t +  0.00*(1-t); }
    return 0;
  }

  // neutral (Megathyrsus / Grass)
  if (pH >= 8.00) return 0.05;
  if (pH >= 7.80) { const t=(pH-7.80)/(8.00-7.80); return 0.05*t + 0.30*(1-t); }
  if (pH >= 7.60) { const t=(pH-7.60)/(7.80-7.60); return 0.30*t + 0.00*(1-t); }
  return 0;
}

// ── 정착/이탈 확률 (임계값 → 확률로 전환) ───────────────────────────────────
// 근거: Munday(2009)의 측정치는 '정착 성공 여부'가 아니라 '냄새 쪽 체류 비율'.
//       따라서 선호도는 임계값으로 잘라내지 말고, 머무는 시간에 비례시켜야 한다.
//       정착률 ∝ pref, 이탈률 ∝ (1 - pref) → 평형 점유율 ∝ pref/(1-pref)
const SETTLE_GAIN = 0.35;   // pref=1.0일 때 프레임당 정착 확률
const LEAVE_BASE  = 0.020;  // pref=0일 때 프레임당 이탈 확률
const LEAVE_SAT   = 0.80;   // pref가 이 값 이상이면 이탈 없음

function settleProbOf(pref) {
  if (pref <= 0.02) return 0;   // 기피/무반응 → 정착 안 함
  return Math.min(0.5, pref * SETTLE_GAIN);
}
function leaveProbOf(pref) {
  return LEAVE_BASE * Math.max(0, 1 - pref / LEAVE_SAT);
}

function initSettleFish() {
  return Array.from({length: INIT_COUNT}, (_, i) => ({
    id: i,
    // 화면 전역 무작위 배치 — 특정 정착지에 가까이 태어나는 편향 제거
    x: Math.random() * W,
    y: Math.random() * H,
    vx: (Math.random()-0.5)*0.8, vy: (Math.random()-0.5)*0.8,
    trail: [], settledAt: null, leaveCooldown: 0,   // null or site.id
    isShutdown: false, shutPH: 99,                  // 후각 상실 상태 + 판정 당시 pH
    sensitivity: Math.max(0.3, Math.min(1.7, 1.0+(Math.random()+Math.random()-1.0)*0.5)),
  }));
}

function stepSettlement(fish, pH) {
  return fish.map(f => {
    // ── 개체별 후각 상실(셧다운) 판정: pH가 바뀌었을 때만 다시 굴림 ──
    let isShutdown = f.isShutdown || false;
    let shutPH = (f.shutPH === undefined) ? 99 : f.shutPH;
    if (Math.abs(shutPH - pH) > 0.001) {
      const shutP = Math.min(0.98, getShutdownProbability(pH) * Math.sqrt(f.sensitivity));
      isShutdown = Math.random() < shutP;
      shutPH = pH;
    }
    // 셧다운된 개체는 후각 상실 → 표류 (노이즈 큼), 정상은 약한 노이즈
    const noise = isShutdown ? 1.9 : 0.55;

    // ══ 이미 정착한 개체 ══════════════════════════════════════════════════
    if (f.settledAt !== null) {
      const site = SITES[f.settledAt];
      const dx = wrapD(site.x - f.x, W), dy = wrapD(site.y - f.y, H);
      const dist = Math.sqrt(dx*dx + dy*dy) + 1e-6;

      const pref = getSitePreference(site.type, pH) * Math.sqrt(f.sensitivity);
      // 셧다운이면 후각 상실 → 높은 이탈률, 그 외엔 선호도 기반 확률
      const leaveProb = isShutdown ? LEAVE_BASE * 3 : leaveProbOf(pref);

      if (Math.random() < leaveProb) {
        // 이탈 방향은 무작위 (정착지 반대편으로 밀면 화면 중앙 쪽으로 편향됨)
        const ang = Math.random() * Math.PI * 2;
        return {
          ...f, settledAt: null, leaveCooldown: 140, isShutdown, shutPH,
          vx: Math.cos(ang) * 2.0, vy: Math.sin(ang) * 2.0,
        };
      }

      // 정착지 주변 배회 (반경 25px 안에서)
      let ax = 0, ay = 0;
      if (dist > 25)      { ax += (dx/dist)*0.5; ay += (dy/dist)*0.5; }
      else if (dist < 10) { ax -= (dx/dist)*0.3; ay -= (dy/dist)*0.3; }
      const a = Math.random()*Math.PI*2;
      ax += Math.cos(a)*0.5; ay += Math.sin(a)*0.5;
      let vx = f.vx*0.85+ax*0.4, vy = f.vy*0.85+ay*0.4;
      const spd = Math.sqrt(vx*vx+vy*vy)+1e-6;
      if (spd > 0.8) { vx=(vx/spd)*0.8; vy=(vy/spd)*0.8; }
      const nx = (f.x + vx + W) % W;
      const ny = (f.y + vy + H) % H;
      const trail = [...f.trail, {x:f.x, y:f.y}].slice(-14);
      return {...f, x:nx, y:ny, vx, vy, trail, isShutdown, shutPH};
    }

    // ══ 미정착 개체 ═══════════════════════════════════════════════════════
    let ax = 0, ay = 0;
    let nearestSettleSite = null, nearestDist = Infinity;

    // 재정착 쿨다운 감소 (이탈 직후엔 정착 금지 → 냄새 범위 밖으로 탈출)
    let cooldown = Math.max(0, (f.leaveCooldown || 0) - 1);
    if (cooldown === 0 && (f.leaveCooldown || 0) > 0) {
      // 아직 정착지 근처면 잠깐 더 유지 (즉시 재흡수 방지)
      let nearMin = Infinity;
      SITES.forEach(site => {
        const sd = Math.hypot(wrapD(f.x - site.x, W), wrapD(f.y - site.y, H));
        if (sd < nearMin) nearMin = sd;
      });
      if (nearMin < SITE_R * 1.5) cooldown = 1;
    }
    const canSettle = cooldown === 0;

    SITES.forEach(site => {
      const dx = wrapD(site.x - f.x, W), dy = wrapD(site.y - f.y, H);
      const dist = Math.sqrt(dx*dx + dy*dy) + 1e-6;

      // ── 정착 판정 ──
      if (dist < SITE_R && canSettle) {
        if (isShutdown) {
          // 후각 상실: '선택'은 못 하나 물리적으로 우연히 머묾
          if (Math.random() < 0.02 && dist < nearestDist) {
            nearestDist = dist; nearestSettleSite = site.id;
          }
        } else {
          // 하드 임계값 제거 → 선호도 비례 확률
          const pref = getSitePreference(site.type, pH) * Math.sqrt(f.sensitivity);
          if (Math.random() < settleProbOf(pref) && dist < nearestDist) {
            nearestDist = dist; nearestSettleSite = site.id;
          }
        }
      }

      // ── 냄새 유인/기피 (셧다운이면 유인력 0 → 표류) ──
      if (dist < SITE_SCENT_R && !isShutdown) {
        const pref = getSitePreference(site.type, pH) * f.sensitivity;
        let strength = pref * 0.85 / (dist * 0.010 + 0.40);
        // 정착 반경 안에서는 유인력을 중심으로 갈수록 0으로 감쇠
        // (감쇠가 없으면 dist→0에서 유인력이 최대 → 오버슛 → 궤도 운동)
        if (dist < SITE_R) strength *= dist / SITE_R;
        ax += (dx/dist) * strength;
        ay += (dy/dist) * strength;
      }
    });

    if (nearestSettleSite !== null) {
      return { ...f, settledAt: nearestSettleSite, trail: [], leaveCooldown: 0, isShutdown, shutPH };
    }

    // 노이즈 (벽 반발력 없음 — 순환 화면이므로 벽이 존재하지 않음)
    const a = Math.random()*Math.PI*2;
    ax += Math.cos(a)*noise; ay += Math.sin(a)*noise;

    // 쿨다운 중: 냄새 유인 무시 + 가장 가까운 정착지에서 멀어지는 방향으로 추진
    if (cooldown > 0) {
      ax = 0; ay = 0;
      let cx = 0, cy = 0, cMin = Infinity;
      SITES.forEach(site => {
        const sdx = wrapD(f.x - site.x, W), sdy = wrapD(f.y - site.y, H);
        const sd = Math.sqrt(sdx*sdx + sdy*sdy) + 1e-6;
        if (sd < cMin) { cMin = sd; cx = sdx/sd; cy = sdy/sd; }
      });
      if (cMin < SITE_SCENT_R + 30) { ax = cx * 2.2; ay = cy * 2.2; }
    }

    const damp  = cooldown > 0 ? 0.80 : 0.92;
    const accel = cooldown > 0 ? 0.55 : 0.35;
    let vx = f.vx*damp + ax*accel, vy = f.vy*damp + ay*accel;
    const maxSpd = cooldown > 0 ? 1.5 : 1.0;
    const spd = Math.sqrt(vx*vx+vy*vy)+1e-6;
    if (spd > maxSpd) { vx=(vx/spd)*maxSpd; vy=(vy/spd)*maxSpd; }

    // 순환 화면 (wrap-around) — 포식자 회피 페이지와 동일 방식
    const px = f.x + vx, py = f.y + vy;
    const nx = (px + W) % W, ny = (py + H) % H;
    const wrapped = Math.abs(nx - px) > 1 || Math.abs(ny - py) > 1;
    const trail = wrapped ? [] : [...f.trail, {x:f.x, y:f.y}].slice(-16);

    return {...f, x:nx, y:ny, vx, vy, trail, leaveCooldown: cooldown, isShutdown, shutPH};
  });
}

function HomingPage({ pH, onPHChange }) {
  const [fish, setFish] = useState(initSettleFish);
  const [tick, setTick] = useState(0);
  const [exposureDays, setExposureDays] = useState(0);
  const fishRef = useRef(fish);
  const pHRef = useRef(pH);
  const tickRef = useRef(0);
  const runRef = useRef(true);
  const rafRef = useRef(null);
  const expRef = useRef(0);
  const prevPHRef = useRef(pH);
  fishRef.current = fish; pHRef.current = pH;

  const animate = useCallback(() => {
    if (!runRef.current) return;
    // pH 변경 감지 → 노출일수 리셋
    if (Math.abs(pHRef.current - prevPHRef.current) > 0.001) {
      prevPHRef.current = pHRef.current; expRef.current = 0;
    }
    // 노출일수 증가 (60fps 가정: 1프레임 = DAYS_PER_SECOND/60 일)
    expRef.current += DAYS_PER_SECOND / 60;
    // 유효 pH로 시뮬레이션
    const ePH = getEffectivePH(pHRef.current, expRef.current);
    const next = stepSettlement(fishRef.current, ePH);
    fishRef.current = next; tickRef.current += 1;
    if (tickRef.current % 2 === 0) {
      setFish([...next]); setTick(tickRef.current);
      setExposureDays(expRef.current);
    }
    rafRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    runRef.current = true;
    rafRef.current = requestAnimationFrame(animate);
    return () => { runRef.current = false; cancelAnimationFrame(rafRef.current); };
  }, [animate]);

  const reset = () => {
    const f = initSettleFish(); fishRef.current = f; setFish(f);
    tickRef.current = 0; setTick(0);
    expRef.current = 0; setExposureDays(0);
  };

  const effPH = getEffectivePH(pH, exposureDays);
  const col = phToCol(effPH);
  const nonR = isNonResponsive(effPH);
  const settledGood    = fish.filter(f => f.settledAt !== null && SITES[f.settledAt].type === 'good').length;
  const settledBad     = fish.filter(f => f.settledAt !== null && SITES[f.settledAt].type === 'bad').length;
  const settledNeutral = fish.filter(f => f.settledAt !== null && SITES[f.settledAt].type === 'neutral').length;
  const unsettled      = fish.filter(f => f.settledAt === null).length;

  // 각 정착지별 개체 수
  const siteCount = SITES.map(s => fish.filter(f => f.settledAt === s.id).length);

  return (
    <div style={{display:"flex",gap:14,flexWrap:"wrap",justifyContent:"center"}}>
      {/* Canvas */}
      <div style={{position:"relative",background:"rgba(2,12,26,0.96)",border:"1px solid rgba(50,110,170,0.2)",borderRadius:12,overflow:"hidden",boxShadow:"0 6px 32px rgba(0,0,0,0.6)",flexShrink:0}}>
        <svg width={W} height={H} style={{display:"block"}}>
          <defs>
            <radialGradient id="hbg" cx="50%" cy="50%" r="65%">
              <stop offset="0%" stopColor="#041c34"/><stop offset="100%" stopColor="#010c1a"/>
            </radialGradient>
            <filter id="hblur5"><feGaussianBlur stdDeviation="5"/></filter>
            <filter id="hblur3"><feGaussianBlur stdDeviation="3"/></filter>
            <filter id="hblur2"><feGaussianBlur stdDeviation="2"/></filter>
          </defs>
          <rect width={W} height={H} fill="url(#hbg)"/>
          {/* 산성화 오라 — effPH 낮을수록 붉은 테두리 진해짐 */}
          {effPH < 8.0 && (
            <rect width={W} height={H} fill="none"
              stroke={"rgba(200,40,80,"+Math.min(0.5,(8.0-effPH)/0.4*0.5)+")"}
              strokeWidth={Math.min(24,(8.0-effPH)/0.4*24)}/>
          )}
          {Array.from({length:9},(_,i)=>(
            <line key={"hv"+i} x1={i*108} y1={0} x2={i*108} y2={H} stroke="rgba(50,110,170,0.03)" strokeWidth="1"/>
          ))}
          {Array.from({length:6},(_,i)=>(
            <line key={"hh"+i} x1={0} y1={i*100} x2={W} y2={i*100} stroke="rgba(50,110,170,0.03)" strokeWidth="1"/>
          ))}

          {/* 정착지들 */}
          {SITES.map(site => {
            const pref = getSitePreference(site.type, effPH);
            const ringColor = nonR ? "rgba(150,150,150,0.30)"
              : pref > 0.1 ? "rgba(255,160,60,0.45)"
              : pref < -0.1 ? "rgba(100,60,40,0.40)"
              : "rgba(100,120,80,0.30)";
            const fillColor = nonR ? "rgba(150,150,150,0.04)"
              : pref > 0.1 ? "rgba(255,140,50,0.07)"
              : pref < -0.1 ? "rgba(100,60,40,0.06)"
              : "rgba(100,120,80,0.04)";
            return (
              <g key={"site"+site.id}>
                {/* 냄새 범위 — 순환 화면이므로 상하좌우로 감싸 그림 (3×3 타일) */}
                {[-W, 0, W].map(ox => [-H, 0, H].map(oy => (
                  <g key={"sc"+site.id+"_"+ox+"_"+oy}>
                    <circle cx={site.x+ox} cy={site.y+oy} r={SITE_SCENT_R}
                      fill={fillColor} filter="url(#hblur3)"/>
                    <circle cx={site.x+ox} cy={site.y+oy} r={SITE_SCENT_R}
                      fill="none" stroke={ringColor} strokeWidth="1.2" strokeDasharray="7 5"/>
                  </g>
                )))}
                {/* 정착 구역 */}
                <circle cx={site.x} cy={site.y} r={SITE_R}
                  fill={site.glow} filter="url(#hblur5)"/>
                <circle cx={site.x} cy={site.y} r={SITE_R}
                  fill="none" stroke={site.color} strokeWidth="1.5" strokeOpacity="0.6"/>
                {/* 아이콘 */}
                <text x={site.x} y={site.y+5} textAnchor="middle" fontSize="18">{site.emoji}</text>
                <text x={site.x} y={site.y+SITE_R+14} textAnchor="middle" fontSize="9" fill={site.color} fontWeight="600">
                  {site.label}
                </text>
                {/* 개체 수 뱃지 */}
                {siteCount[site.id] > 0 && (
                  <g>
                    <circle cx={site.x+SITE_R-2} cy={site.y-SITE_R+2} r={9}
                      fill={site.type==='good'?"#ff6b1a":site.type==='bad'?"#7a3a1a":"#4a6a2a"}/>
                    <text x={site.x+SITE_R-2} y={site.y-SITE_R+6}
                      textAnchor="middle" fontSize="9" fill="white" fontWeight="800">
                      {siteCount[site.id]}
                    </text>
                  </g>
                )}
                {/* pH에 따른 반응 표시 */}
                {!nonR && (
                  <text x={site.x} y={site.y-SITE_R-8} textAnchor="middle" fontSize="8.5"
                    fill={pref>0.1?"rgba(255,160,60,0.8)":pref<-0.1?"rgba(160,80,60,0.8)":"rgba(120,140,80,0.6)"}
                    fontWeight="600">
                    {pref>0.5?"← 강한 유인":pref>0.1?"← 유인":pref<-0.5?"기피 →":pref<-0.1?"약한 기피 →":"중립"}
                  </text>
                )}
              </g>
            );
          })}

          {/* 물고기 */}
          {fish.map((f,fi) => {
            const hue = 15+(fi%10)*11;
            const fAngle = Math.atan2(f.vy, f.vx)*180/Math.PI;
            const settled = f.settledAt !== null;
            const siteType = settled ? SITES[f.settledAt].type : null;
            const shut = f.isShutdown && !settled;  // 미정착 + 후각상실 = 표류
            const fishColor = shut
              ? "hsl(220,8%,55%)"  // 셧다운: 회색 (후각 상실 표류)
              : settled
              ? (siteType==='good'?"hsl("+hue+",78%,65%)":siteType==='bad'?"hsl(20,55%,42%)":"hsl(90,40%,48%)")
              : "hsl("+hue+",78%,56%)";
            return (
              <g key={"hf"+f.id}>
                {shut && <circle cx={f.x} cy={f.y} r={10} fill="rgba(150,150,160,0.32)" filter="url(#hblur2)"/>}
                {!settled && f.trail.length>1 && f.trail.map((pt,ti) => {
                  if(ti===0) return null;
                  const prev = f.trail[ti-1];
                  const alpha = (ti/f.trail.length)*0.25;
                  return <line key={"htr"+ti} x1={prev.x} y1={prev.y} x2={pt.x} y2={pt.y}
                    stroke={"hsla("+hue+",76%,58%,"+alpha+")"} strokeWidth="1" strokeLinecap="round"/>;
                })}
                <g transform={"translate("+f.x+","+f.y+") rotate("+(settled?0:fAngle)+")"}>
                  <ellipse rx="4.5" ry="2.6" fill={fishColor}/>
                  <ellipse rx="1.2" ry="2.4" cx="0.4" fill="white" opacity="0.46"/>
                  <polygon points="-4.5,0 -9.5,-2.5 -9.5,2.5" fill={settled?"rgba(150,150,150,0.5)":"hsl("+hue+",66%,44%)"}/>
                  <circle cx="2.5" cy="-1" r="1.2" fill="#0a0808"/>
                  <circle cx="2.8" cy="-1.3" r="0.5" fill="white"/>
                </g>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Panel */}
      <div style={{display:"flex",flexDirection:"column",gap:11,minWidth:240,maxWidth:256}}>
        {/* pH 슬라이더 */}
        <div style={{background:"rgba(5,16,32,0.95)",border:"1px solid "+col+"48",borderRadius:11,padding:"13px 16px",boxShadow:"0 0 14px "+col+"10"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
            <span style={{fontSize:11,color:"#3a7898",fontWeight:600,letterSpacing:1}}>해수 pH</span>
            <span style={{fontSize:26,fontWeight:800,color:col}}>{pH.toFixed(2)}</span>
          </div>
          <input type="range" min="7.60" max="8.15" step="0.05" value={pH}
            onChange={e=>onPHChange(parseFloat(e.target.value))}
            style={{width:"100%",accentColor:col,cursor:"pointer",marginBottom:4}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#285060",marginBottom:5}}>
            <span>7.60</span><span>8.15</span>
          </div>
          <div className={effPH <= 7.80 ? "gaba-reversal" : ""} style={{fontSize:11,color:col,fontWeight:600,textAlign:"center"}}>{phLabel(effPH)}</div>
        </div>

        {/* 노출 기간 */}
        <div style={{background:"rgba(5,16,32,0.95)",border:"1px solid rgba(50,110,170,0.2)",borderRadius:11,padding:"12px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
            <span style={{fontSize:10.5,color:"#3a7898",letterSpacing:1,fontWeight:600}}>노출 기간</span>
            <span style={{fontSize:18,fontWeight:800,color:"#7ab8d8"}}>{exposureDays.toFixed(1)}<span style={{fontSize:10,color:"#3a6070",marginLeft:2}}>일</span></span>
          </div>
          <div style={{background:"rgba(255,255,255,0.06)",borderRadius:99,height:5,marginBottom:6}}>
            <div style={{height:"100%",borderRadius:99,width:Math.min(100,exposureDays/EXPOSURE_FULL_DAYS*100)+"%",background:"#5a9fcf",transition:"width 0.2s"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:4}}>
            <span style={{color:"#5a8aa0"}}>설정 pH</span>
            <span style={{color:"#8ab8d0",fontWeight:600}}>{pH.toFixed(2)}</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10}}>
            <span style={{color:"#5a8aa0"}}>유효 pH (현재 발현)</span>
            <span style={{color:col,fontWeight:700}}>{effPH.toFixed(2)}</span>
          </div>
          <div style={{fontSize:8.5,color:"#2a4860",marginTop:6,lineHeight:1.6}}>
            Munday (2009): 산성화 노출 후 약 2~4일에 걸쳐 행동 손상이 발현. pH 변경 시 노출 0일로 리셋.
          </div>
        </div>

        {/* 정착 현황 */}
        <div style={{background:"rgba(5,16,32,0.95)",border:"1px solid rgba(50,110,170,0.2)",borderRadius:11,padding:"13px 16px"}}>
          <div style={{fontSize:10.5,color:"#3a7898",letterSpacing:1,fontWeight:600,marginBottom:10}}>정착 현황</div>
          {[
            {label:"🌿 좋은 정착지",n:settledGood, color:"#ff8c3a", desc:"말미잘 + Xanthostemon (2곳)"},
            {label:"🪵 나쁜 정착지",n:settledBad,  color:"#a06040", desc:"Melaleuca 독성 (2곳)"},
            {label:"🌾 중립 정착지",n:settledNeutral,color:"#6a8a4a",desc:"Grass (2곳)"},
            {label:"🌊 미정착 (표류)",n:unsettled,   color:"#4a7898", desc:"냄새 탐색 중"},
          ].map(({label,n,color,desc})=>(
            <div key={label} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:2}}>
                <span style={{color:"#8ab8d0"}}>{label}</span>
                <span style={{color,fontWeight:700}}>{n}마리</span>
              </div>
              <div style={{background:"rgba(255,255,255,0.06)",borderRadius:99,height:4}}>
                <div style={{height:"100%",borderRadius:99,width:(n/INIT_COUNT*100)+"%",background:color,transition:"width 0.4s"}}/>
              </div>
              <div style={{fontSize:8.5,color:"#2a4860",marginTop:1}}>{desc}</div>
            </div>
          ))}
        </div>

        {/* 선호도 현황 — 각 유형 대표 1곳 (id 0=good, 1=bad, 2=neutral) */}
        <div style={{background:"rgba(5,16,32,0.95)",border:"1px solid rgba(50,110,170,0.2)",borderRadius:11,padding:"12px 16px"}}>
          <div style={{fontSize:10.5,color:"#3a7898",letterSpacing:1,fontWeight:600,marginBottom:8}}>현재 냄새 선호도</div>
          {SITES.filter((s,i)=>[0,1,2].includes(i)).map(site=>{
            const pref = getSitePreference(site.type, effPH);
            const bc = pref>0.1?"#ff8c3a":pref<-0.1?"#a06040":"#6a8a5a";
            return (
              <div key={"pref"+site.id} style={{marginBottom:7}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
                  <span style={{color:"#6a90a8"}}>{site.emoji} {site.label.split('+')[0]}</span>
                  <span style={{color:bc,fontWeight:700}}>{pref>0?"유인 "+Math.round(pref*100)+"%":pref<0?"기피 "+Math.round(-pref*100)+"%":"무반응"}</span>
                </div>
                <div style={{position:"relative",height:5,background:"rgba(255,255,255,0.06)",borderRadius:99,overflow:"hidden"}}>
                  <div style={{position:"absolute",left:"50%",top:0,bottom:0,width:1,background:"rgba(255,255,255,0.15)"}}/>
                  {pref>=0
                    ?<div style={{position:"absolute",left:"50%",width:(pref*50)+"%",top:0,bottom:0,background:"rgba(255,140,50,0.7)",transition:"width 0.4s"}}/>
                    :<div style={{position:"absolute",right:"50%",width:(-pref*50)+"%",top:0,bottom:0,background:"rgba(160,80,40,0.7)",transition:"width 0.4s"}}/>
                  }
                </div>
              </div>
            );
          })}
          <div style={{fontSize:9,color:"#2a4860",marginTop:6,lineHeight:1.7}}>
            <b style={{color:"#5a8aa0"}}>Munday et al. (2009)</b><br/>
            pH 7.8: Melaleuca 기피→유인 역전 (80%↑ 체류)<br/>
            pH 7.6: 모든 냄새 무반응 (표류)
          </div>
        </div>

        <button onClick={reset} style={{padding:"9px 0",borderRadius:9,border:"none",background:"rgba(50,110,170,0.13)",color:"#5aa8ca",fontWeight:700,fontSize:12,cursor:"pointer",outline:"1px solid rgba(50,110,170,0.24)"}}>
          ↺ 초기화
        </button>
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════════════════════════════════════
// PAGE 2 — 포식자 회피 시뮬레이션
// ══════════════════════════════════════════════════════════════════════════════
const CATCH_R = 11;
const PRED_SPEED = 0.70;
const PATROL = [
  {x:120,y:100},{x:740,y:100},{x:740,y:400},
  {x:120,y:400},{x:430,y:180},{x:430,y:350},
];

function initPredFish() {
  return Array.from({length:INIT_COUNT},(_,i)=>{
    const angle=(i/INIT_COUNT)*Math.PI*2;
    const r=100+Math.random()*120;
    return {
      id:i, x:ANEMONE.x+Math.cos(angle)*r, y:ANEMONE.y+Math.sin(angle)*r,
      vx:(Math.random()-0.5)*0.9, vy:(Math.random()-0.5)*0.9,
      trail:[], alive:true, deathFlash:0,
      latencyCounter:0, inDanger:false,
      isShutdown:false, isReversed:false, shutPH:99,  // 후각상실/역전 상태 + 판정 당시 pH
      sensitivity:Math.max(0.3,Math.min(1.7,1.0+(Math.random()+Math.random()-1.0)*0.55)),
    };
  });
}

function initPred2() {
  return {x:120,y:100,vx:0.6,vy:0.4,waypointIdx:0,hunting:false};
}

function stepPred(fish, pred, pH) {
  const latency = getReactionLatency(pH);
  const noise = 0.7;  // 기본 유영 노이즈 (활발한 유영으로 구석 정체 방지)

  // 포식자 이동 — 전방 시야각 제한 타겟팅 (전지전능 시야 방지)
  const alive = fish.filter(f=>f.alive);
  let tx=pred.x,ty=pred.y,minD=Infinity;
  const predHeading = Math.atan2(pred.vy, pred.vx);  // 포식자 진행 방향
  const HALF_FOV = (130 * Math.PI / 180) / 2;        // 시야각 130도의 절반
  alive.forEach(f=>{
    // 포식자는 순환하지 않으므로 일반 거리로 타겟팅 (화면 가로지르기 방지)
    const dx=f.x-pred.x,dy=f.y-pred.y,d=Math.sqrt(dx*dx+dy*dy);
    // 전방 시야각 안이거나, 아주 가까우면(50px 이내, 측면감지) 인지
    const angleToFish = Math.atan2(dy, dx);
    let diff = Math.abs(predHeading - angleToFish);
    if (diff > Math.PI) diff = Math.PI*2 - diff;
    const visible = d < 50 || diff < HALF_FOV;
    if(visible && d<minD){minD=d;tx=f.x;ty=f.y;}
  });
  // 포식자 시력:
  // - 순찰 중: VISUAL_R 안에 물고기가 있으면 확률적으로 발견 (시력 불완전)
  // - 추적 중: HUNT_R 안에 있으면 계속 추적 (냄새+시각 조합)
  const VISUAL_R = 140;  // 순찰 중 시야 반경
  const HUNT_R   = 220;  // 추적 모드 유지 반경 (한번 발견 후)
  // 순찰 중 발견 확률: 거리 가까울수록 높음 (매 프레임 판정)
  const spotProb = minD < VISUAL_R ? Math.pow(1 - minD/VISUAL_R, 1.5) * 0.12 : 0;
  const wasHunting = pred.hunting || false;
  const hunting = wasHunting
    ? minD < HUNT_R                          // 추적 중: HUNT_R 안이면 유지
    : (minD < VISUAL_R && Math.random() < spotProb); // 순찰 중: 확률적 발견
  let newWpIdx=pred.waypointIdx;
  let tgtX,tgtY;
  if(hunting){tgtX=tx;tgtY=ty;}
  else{
    const wp=PATROL[pred.waypointIdx];
    const wdx=wp.x-pred.x,wdy=wp.y-pred.y;
    if(Math.sqrt(wdx*wdx+wdy*wdy)<28) newWpIdx=(pred.waypointIdx+1)%PATROL.length;
    tgtX=PATROL[newWpIdx].x; tgtY=PATROL[newWpIdx].y;
  }
  let toFx=tgtX-pred.x,toFy=tgtY-pred.y;
  const toFd=Math.sqrt(toFx*toFx+toFy*toFy)+1e-6;
  const acc=hunting?0.30:0.18;
  let pvx=pred.vx*0.88+(toFx/toFd)*PRED_SPEED*acc;
  let pvy=pred.vy*0.88+(toFy/toFd)*PRED_SPEED*acc;
  // 화면 끝에 가까우면 안쪽으로 부드럽게 선회 (점프 없이 자연스러운 방향 전환)
  const MARGIN=70;
  if(pred.x<MARGIN)      pvx += (1-pred.x/MARGIN)*0.5;
  else if(pred.x>W-MARGIN) pvx -= (1-(W-pred.x)/MARGIN)*0.5;
  if(pred.y<MARGIN)      pvy += (1-pred.y/MARGIN)*0.5;
  else if(pred.y>H-MARGIN) pvy -= (1-(H-pred.y)/MARGIN)*0.5;
  // 종말 스트라이크: 추적 중 표적이 코앞(25px 이내)이면 순간 가속으로 덮침
  const STRIKE_R = 25, STRIKE_SPEED = 1.6;
  const speedCap = (hunting && minD < STRIKE_R) ? STRIKE_SPEED : PRED_SPEED;
  const pspd=Math.sqrt(pvx*pvx+pvy*pvy)+1e-6;
  if(pspd>speedCap){pvx=(pvx/pspd)*speedCap;pvy=(pvy/pspd)*speedCap;}
  // 포식자는 순환하지 않음 — 화면 안에 부드럽게 머묾 (안전 클램프)
  let pnx=Math.max(8,Math.min(W-8,pred.x+pvx));
  let pny=Math.max(8,Math.min(H-8,pred.y+pvy));
  const newPred={x:pnx,y:pny,vx:pvx,vy:pvy,waypointIdx:newWpIdx,hunting};

  // 물고기 이동
  const newFish = fish.map(f=>{
    if(!f.alive) return {...f,deathFlash:Math.max(0,f.deathFlash-1)};
    // 순환(wrap-around) 거리: 화면 경계를 넘어가는 경로가 더 짧으면 그쪽으로 계산
    let toPx=newPred.x-f.x, toPy=newPred.y-f.y;
    if(toPx > W/2) toPx-=W; else if(toPx < -W/2) toPx+=W;
    if(toPy > H/2) toPy-=H; else if(toPy < -H/2) toPy+=H;
    const distP=Math.sqrt(toPx*toPx+toPy*toPy)+1e-6;
    if(distP<CATCH_R) return {...f,alive:false,deathFlash:22,vx:0,vy:0};

    const inScent=distP<SCENT_R;
    let isReversed=f.isReversed||false;  // 역전 상태 (개체에 고정)
    let isShutdown=f.isShutdown||false;  // 후각 상실 상태 (개체에 고정)
    let shutPH=(f.shutPH===undefined)?99:f.shutPH;
    // pH가 바뀌었을 때 전 개체가 즉시 셧다운/역전 판정 (포식자 위치 무관)
    if(Math.abs(shutPH - pH) > 0.001){
      const shutP = Math.min(0.98, getShutdownProbability(pH) * Math.sqrt(f.sensitivity));
      isShutdown = Math.random() < shutP;
      if(!isShutdown){
        const revP = Math.min(0.98, getReversalProbability(pH) * Math.sqrt(f.sensitivity));
        isReversed = Math.random() < revP;
      } else {
        isReversed = false;
      }
      shutPH = pH;
    }
    // 반응 지연 처리 (위험 감지 시점에 latency 카운터만 다룸)
    let latencyCounter=f.latencyCounter;
    let inDanger=f.inDanger;
    if(inScent && !inDanger){
      inDanger=true; latencyCounter=latency;
    } else if(!inScent){
      inDanger=false; latencyCounter=0;
    } else if(latencyCounter>0){
      latencyCounter--;
    }
    // 셧다운된 개체는 반응 불가 (지연과 무관하게 무반응)
    const canReact = inDanger && latencyCounter===0 && !isShutdown;

    let ax=0,ay=0;
    // ── 긴박도(urgency): 포식자가 가까울수록 0→1로 급증 (C-start burst escape) ──
    const urgency = inScent ? Math.max(0, Math.min(1, (SCENT_R - distP) / (SCENT_R - 25))) : 0;
    if(canReact) {
      const ux=toPx/distP,uy=toPy/distP;  // 포식자 → 나 방향
      // 역전: 포식자로 직진(+) / 정상: 정반대로 회피(-)
      const dir = isReversed ? +1 : -1;
      const mag = isReversed ? f.sensitivity : 1/Math.max(0.5,f.sensitivity);
      const burst = 1 + urgency*urgency*5;  // 가까울수록 폭발적 도주
      const strength = mag*2.0/(distP*0.012+0.5) * burst;
      ax += ux*dir*strength; ay += uy*dir*strength;
    }
    // ── 노이즈: 위험 반응 중엔 대폭 감소 → 회피 방향이 노이즈에 묻히지 않음 ──
    let indivNoise;
    if(isShutdown) indivNoise = 1.9;
    else if(canReact) indivNoise = noise * (1 - urgency*0.85);
    else indivNoise = noise;
    const a=Math.random()*Math.PI*2;
    ax+=Math.cos(a)*indivNoise; ay+=Math.sin(a)*indivNoise;
    // (벽 반발 없음 — 화면이 순환 구조)

    // 긴박할수록 최대 속도 증가 (burst escape: 평소 1.1 → 최대 2.0)
    const maxSpd = isShutdown ? 1.1 : (1.1 + urgency*0.9);
    let vx=f.vx*0.86+ax*0.48,vy=f.vy*0.86+ay*0.48;
    const spd=Math.sqrt(vx*vx+vy*vy)+1e-6;
    if(spd>maxSpd){vx=(vx/spd)*maxSpd;vy=(vy/spd)*maxSpd;}
    // 순환 위치: 한쪽 벽을 넘으면 반대편으로 재등장 (wrap-around)
    let nx=f.x+vx, ny=f.y+vy;
    if(nx<0) nx+=W; else if(nx>=W) nx-=W;
    if(ny<0) ny+=H; else if(ny>=H) ny-=H;
    // 화면을 가로질러 순간이동할 때 잔상(trail)이 길게 늘어지지 않도록 처리
    const wrapped = Math.abs(nx-f.x)>W/2 || Math.abs(ny-f.y)>H/2;
    const trail = wrapped ? [] : [...f.trail,{x:f.x,y:f.y}].slice(-16);
    return {...f,x:nx,y:ny,vx,vy,trail,inScent,latencyCounter,inDanger,isReversed,isShutdown,shutPH,deathFlash:Math.max(0,f.deathFlash-1)};
  });
  return {fish:newFish,pred:newPred};
}

function PredatorPage({ pH, onPHChange }) {
  const [fish,setFish]=useState(initPredFish);
  const [pred,setPred]=useState(initPred2);
  const [tick,setTick]=useState(0);
  const [survLog,setSurvLog]=useState([{t:0,n:INIT_COUNT}]);
  const [gameOver,setGameOver]=useState(false);
  const [exposureDays,setExposureDays]=useState(0);
  const fishRef=useRef(fish),predRef=useRef(pred),pHRef=useRef(pH);
  const runRef=useRef(true),goRef=useRef(false),tickRef=useRef(0);
  const logRef=useRef([{t:0,n:INIT_COUNT}]),rafRef=useRef(null);
  const expRef=useRef(0),prevPHRef=useRef(pH);
  fishRef.current=fish; predRef.current=pred; pHRef.current=pH;

  const animate=useCallback(()=>{
    if(!runRef.current||goRef.current) return;
    // pH 변경 감지 → 노출일수 리셋
    if(Math.abs(pHRef.current - prevPHRef.current) > 0.001){
      prevPHRef.current = pHRef.current; expRef.current = 0;
    }
    expRef.current += DAYS_PER_SECOND / 60;
    const ePH = getEffectivePH(pHRef.current, expRef.current);
    const res=stepPred(fishRef.current,predRef.current,ePH);
    fishRef.current=res.fish; predRef.current=res.pred; tickRef.current+=1;
    const aliveN=res.fish.filter(f=>f.alive).length;
    if(aliveN===0&&!goRef.current){goRef.current=true;setGameOver(true);}
    if(tickRef.current%2===0){
      logRef.current=[...logRef.current.slice(-99),{t:tickRef.current,n:aliveN}];
      setSurvLog([...logRef.current]);
      setFish([...res.fish]); setPred({...res.pred}); setTick(tickRef.current);
      setExposureDays(expRef.current);
    }
    rafRef.current=requestAnimationFrame(animate);
  },[]);

  useEffect(()=>{
    runRef.current=true; rafRef.current=requestAnimationFrame(animate);
    return ()=>{runRef.current=false;cancelAnimationFrame(rafRef.current);};
  },[animate]);

  const reset=()=>{
    cancelAnimationFrame(rafRef.current); goRef.current=false;
    const f=initPredFish(),pr=initPred2();
    fishRef.current=f; predRef.current=pr;
    setFish(f); setPred(pr);
    tickRef.current=0; logRef.current=[{t:0,n:INIT_COUNT}];
    setSurvLog([{t:0,n:INIT_COUNT}]); setGameOver(false); setTick(0);
    expRef.current=0; setExposureDays(0);
    runRef.current=true; rafRef.current=requestAnimationFrame(animate);
  };

  const effPH=getEffectivePH(pH, exposureDays);
  const bias=getPredatorBias(effPH);
  const latency=getReactionLatency(effPH);
  const col=phToCol(effPH);
  const aliveN=fish.filter(f=>f.alive).length;
  const survRate=Math.round((aliveN/INIT_COUNT)*100);
  const srColor=survRate>60?"#3de090":survRate>30?"#f0c040":"#f05050";
  const predAngle=Math.atan2(pred.vy,pred.vx)*180/Math.PI;
  const hunting=pred.hunting||false;
  const biasCol=bias<=-0.2?"#3de090":bias<0.2?"#f0c040":"#f05050";
  const biasLabel=bias<=-0.8?"정상 회피":bias<=-0.2?"약한 회피 (부분 손상)":bias<0.2?"무반응":bias<0.8?"약한 유인":"강한 유인 (GABAA 역전)";
  const cW=220,cH=52;
  const chartPts=survLog.map((d,i)=>{
    const x=survLog.length<2?0:(i/(survLog.length-1))*cW;
    const y=cH-(d.n/INIT_COUNT)*cH;
    return x+","+y;
  }).join(" ");
  // 지연 중인 개체 수
  const waitingN=fish.filter(f=>f.alive&&f.inDanger&&f.latencyCounter>0).length;

  return (
    <div style={{display:"flex",gap:14,flexWrap:"wrap",justifyContent:"center"}}>
      {/* Canvas */}
      <div style={{position:"relative",background:"rgba(2,12,26,0.96)",border:"1px solid rgba(50,110,170,0.2)",borderRadius:12,overflow:"hidden",boxShadow:"0 6px 32px rgba(0,0,0,0.6)",flexShrink:0}}>
        <svg width={W} height={H} style={{display:"block"}}>
          <defs>
            <radialGradient id="pbg" cx="50%" cy="50%" r="65%">
              <stop offset="0%" stopColor="#041c34"/><stop offset="100%" stopColor="#010c1a"/>
            </radialGradient>
            <radialGradient id="pPGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#991111" stopOpacity="0.42"/><stop offset="100%" stopColor="#330000" stopOpacity="0"/>
            </radialGradient>
            <filter id="pblur5"><feGaussianBlur stdDeviation="5"/></filter>
            <filter id="pblur2"><feGaussianBlur stdDeviation="2"/></filter>
          </defs>
          <rect width={W} height={H} fill="url(#pbg)"/>
          {/* 산성화 오라 — effPH 낮을수록 붉은 테두리 진해짐 */}
          {effPH < 8.0 && (
            <rect width={W} height={H} fill="none"
              stroke={"rgba(200,40,80,"+Math.min(0.5,(8.0-effPH)/0.4*0.5)+")"}
              strokeWidth={Math.min(24,(8.0-effPH)/0.4*24)}/>
          )}
          {Array.from({length:9},(_,i)=>(
            <line key={"pv"+i} x1={i*108} y1={0} x2={i*108} y2={H} stroke="rgba(50,110,170,0.03)" strokeWidth="1"/>
          ))}
          {Array.from({length:6},(_,i)=>(
            <line key={"ph"+i} x1={0} y1={i*100} x2={W} y2={i*100} stroke="rgba(50,110,170,0.03)" strokeWidth="1"/>
          ))}

          {/* 냄새 범위 */}
          <circle cx={pred.x} cy={pred.y} r={SCENT_R}
            fill={bias>0.1?"rgba(200,50,50,0.06)":bias<-0.1?"rgba(50,190,100,0.06)":"rgba(190,170,50,0.04)"}
            filter="url(#pblur2)"/>
          <circle cx={pred.x} cy={pred.y} r={SCENT_R} fill="none"
            stroke={bias>0.1?"rgba(210,60,60,0.55)":bias<-0.1?"rgba(60,200,110,0.50)":"rgba(200,180,60,0.38)"}
            strokeWidth="1.4" strokeDasharray="7 5"/>
          {[0.62,0.36].map((fr,ri)=>(
            <circle key={"pri"+ri} cx={pred.x} cy={pred.y} r={SCENT_R*fr} fill="none"
              stroke={bias>0.1?"rgba(200,55,55,0.22)":"rgba(55,190,100,0.18)"}
              strokeWidth="1" strokeDasharray="5 6"/>
          ))}
          <text x={pred.x} y={pred.y-SCENT_R-7} textAnchor="middle" fontSize="9"
            fill={bias>0.1?"rgba(210,80,80,0.75)":bias<-0.1?"rgba(70,200,120,0.70)":"rgba(180,160,80,0.60)"}
            fontWeight="600">
            {bias>0.1?"유인됨":bias<-0.1?"회피":"무반응"}
          </text>

          {/* 포식자 */}
          <circle cx={pred.x} cy={pred.y} r={hunting?58:38} fill="url(#pPGlow)" filter="url(#pblur5)" opacity={hunting?1:0.5}/>
          <circle cx={pred.x} cy={pred.y} r={11} fill="rgba(150,18,18,0.15)" stroke="rgba(220,55,55,0.30)" strokeWidth="1"/>
          <g transform={"translate("+pred.x+","+pred.y+") rotate("+predAngle+")"}>
            <ellipse rx="12" ry="6.7" fill="#440c0c" stroke="#a02424" strokeWidth="1.3" strokeOpacity="0.85"/>
            <polygon points="12,0 19,-6 19,6" fill="#581414"/>
            <circle cx="8.4" cy="-3.1" r="3.4" fill="#080303" stroke="#dd2222" strokeWidth="1.1"/>
            <circle cx="9" cy="-3.6" r="1.4" fill="#ff8888"/>
          </g>
          <text x={pred.x} y={pred.y+22} textAnchor="middle" fontSize="8.5"
            fill={hunting?"rgba(240,80,80,0.85)":"rgba(150,110,110,0.5)"} fontWeight="600">
            {hunting?"추적 중":"순찰 중"}
          </text>

          {/* 물고기 */}
          {fish.map((f,fi)=>{
            if(!f.alive&&f.deathFlash<=0) return null;
            const hue=15+(fi%10)*11;
            const fAngle=Math.atan2(f.vy,f.vx)*180/Math.PI;
            const op=f.alive?1:(f.deathFlash/22)*0.7;
            const glowFill = f.alive && f.isShutdown
              ? "rgba(150,150,160,0.40)"
              : (f.alive && f.inScent
                ?(f.latencyCounter>0?"rgba(220,200,50,0.55)"
                :f.isReversed?"rgba(220,80,80,0.62)"
                :"rgba(60,200,110,0.45)")
                :"none");
            const showGlow = f.alive && (f.isShutdown || f.inScent);
            const bodyMain = f.isShutdown ? "hsl(220,8%,58%)"
              : (f.inScent && f.isReversed && f.latencyCounter===0) ? "hsl(2,75%,58%)"
              : "hsl("+hue+",78%,56%)";
            const bodyTail = f.isShutdown ? "hsl(220,8%,42%)"
              : (f.inScent && f.isReversed && f.latencyCounter===0) ? "hsl(2,60%,44%)"
              : "hsl("+hue+",66%,44%)";
            const trailHue = f.isShutdown ? "220,8%,55%"
              : (f.inScent && f.isReversed && f.latencyCounter===0) ? "2,70%,56%"
              : hue+",76%,58%";
            return (
              <g key={"pf"+f.id} opacity={op}>
                {showGlow&&<circle cx={f.x} cy={f.y} r={13} fill={glowFill} filter="url(#pblur2)"/>}
                {f.alive&&f.trail.length>1&&f.trail.map((pt,ti)=>{
                  if(ti===0) return null;
                  const prev=f.trail[ti-1];
                  const alpha=(ti/f.trail.length)*0.30;
                  return <line key={"ptr"+ti} x1={prev.x} y1={prev.y} x2={pt.x} y2={pt.y}
                    stroke={"hsla("+trailHue+","+alpha+")"} strokeWidth="1.1" strokeLinecap="round"/>;
                })}
                {!f.alive&&<circle cx={f.x} cy={f.y} r={7} fill={"rgba(255,85,35,"+(f.deathFlash/22*0.5)+")"}/>}
                <g transform={"translate("+f.x+","+f.y+") rotate("+(f.alive?fAngle:90)+")"}>
                  {f.alive?(
                    <>
                      <ellipse rx="4.5" ry="2.6" fill={bodyMain}/>
                      <ellipse rx="1.2" ry="2.4" cx="0.4" fill="white" opacity="0.46"/>
                      <polygon points="-4.5,0 -9.5,-2.5 -9.5,2.5" fill={bodyTail}/>
                      <circle cx="2.5" cy="-1" r="1.2" fill="#0a0808"/>
                      <circle cx="2.8" cy="-1.3" r="0.5" fill="white"/>
                    </>
                  ):(
                    <>
                      <ellipse rx="4" ry="2.2" fill="#553020" opacity="0.6"/>
                      <line x1="-3" y1="-3" x2="3" y2="3" stroke="#ff5530" strokeWidth="1.3"/>
                      <line x1="3" y1="-3" x2="-3" y2="3" stroke="#ff5530" strokeWidth="1.3"/>
                    </>
                  )}
                </g>
              </g>
            );
          })}
        </svg>
        {gameOver&&(
          <div style={{position:"absolute",inset:0,background:"rgba(1,6,16,0.86)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",borderRadius:12}}>
            <div style={{fontSize:36}}>☠️</div>
            <div style={{fontSize:18,fontWeight:800,color:"#f05555",marginTop:10}}>전멸</div>
            <div style={{fontSize:12,color:"#7a9eb8",marginTop:6,textAlign:"center",lineHeight:1.7}}>
              pH {pH.toFixed(2)} 환경에서 모든 개체 포식됨
            </div>
            <button onClick={reset} style={{marginTop:14,padding:"8px 22px",borderRadius:9,background:"rgba(50,110,180,0.2)",border:"1px solid rgba(50,110,180,0.36)",color:"#60a8cc",fontWeight:700,fontSize:12,cursor:"pointer"}}>
              ↺ 재시작
            </button>
          </div>
        )}
      </div>

      {/* Panel */}
      <div style={{display:"flex",flexDirection:"column",gap:11,minWidth:240,maxWidth:256}}>
        <div style={{background:"rgba(5,16,32,0.95)",border:"1px solid "+col+"48",borderRadius:11,padding:"13px 16px",boxShadow:"0 0 14px "+col+"10"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
            <span style={{fontSize:11,color:"#3a7898",fontWeight:600,letterSpacing:1}}>해수 pH</span>
            <span style={{fontSize:26,fontWeight:800,color:col}}>{pH.toFixed(2)}</span>
          </div>
          <input type="range" min="7.60" max="8.15" step="0.05" value={pH}
            onChange={e=>onPHChange(parseFloat(e.target.value))}
            style={{width:"100%",accentColor:col,cursor:"pointer",marginBottom:4}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#285060",marginBottom:5}}>
            <span>7.60</span><span>8.15</span>
          </div>
          <div className={effPH <= 7.80 ? "gaba-reversal" : ""} style={{fontSize:11,color:col,fontWeight:600,textAlign:"center"}}>{phLabel(effPH)}</div>
        </div>

        {/* 노출 기간 */}
        <div style={{background:"rgba(5,16,32,0.95)",border:"1px solid rgba(50,110,170,0.2)",borderRadius:11,padding:"12px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
            <span style={{fontSize:10.5,color:"#3a7898",letterSpacing:1,fontWeight:600}}>노출 기간</span>
            <span style={{fontSize:18,fontWeight:800,color:"#7ab8d8"}}>{exposureDays.toFixed(1)}<span style={{fontSize:10,color:"#3a6070",marginLeft:2}}>일</span></span>
          </div>
          <div style={{background:"rgba(255,255,255,0.06)",borderRadius:99,height:5,marginBottom:6}}>
            <div style={{height:"100%",borderRadius:99,width:Math.min(100,exposureDays/EXPOSURE_FULL_DAYS*100)+"%",background:"#5a9fcf",transition:"width 0.2s"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:4}}>
            <span style={{color:"#5a8aa0"}}>설정 pH</span>
            <span style={{color:"#8ab8d0",fontWeight:600}}>{pH.toFixed(2)}</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10}}>
            <span style={{color:"#5a8aa0"}}>유효 pH (현재 발현)</span>
            <span style={{color:col,fontWeight:700}}>{effPH.toFixed(2)}</span>
          </div>
          <div style={{fontSize:8.5,color:"#2a4860",marginTop:6,lineHeight:1.6}}>
            Munday (2009): pH 7.8 노출 후 약 2일에 걸쳐 행동 역전. pH 변경 시 노출 0일로 리셋.
          </div>
        </div>

        {/* 반응 지표 */}
        <div style={{background:"rgba(5,16,32,0.95)",border:"1px solid rgba(50,110,170,0.2)",borderRadius:11,padding:"13px 16px"}}>
          <div style={{fontSize:10.5,color:"#3a7898",letterSpacing:1,fontWeight:600,marginBottom:10}}>행동 지표</div>

          {/* GABAA 반응 양극 바 */}
          <div style={{fontSize:10.5,color:"#5a8aa0",marginBottom:4}}>포식자 반응 (GABA<sub>A</sub>)</div>
          <div style={{position:"relative",height:14,background:"rgba(255,255,255,0.05)",borderRadius:99,overflow:"hidden",marginBottom:3}}>
            {bias<=0
              ?<div style={{position:"absolute",right:"50%",width:(Math.abs(bias)*50)+"%",top:0,bottom:0,background:"rgba(60,200,110,0.70)",transition:"width 0.5s"}}/>
              :<div style={{position:"absolute",left:"50%",width:(bias*50)+"%",top:0,bottom:0,background:"rgba(220,60,60,0.72)",transition:"width 0.5s"}}/>
            }
            <div style={{position:"absolute",left:"50%",top:0,bottom:0,width:1.5,background:"rgba(255,255,255,0.18)"}}/>
          </div>
          <div style={{padding:"4px 8px",borderRadius:6,background:biasCol+"14",border:"1px solid "+biasCol+"28",fontSize:10.5,color:biasCol,fontWeight:700,textAlign:"center",marginBottom:10}}>
            {biasLabel}
          </div>

          {/* 반응 지연 */}
          <div style={{fontSize:10.5,color:"#5a8aa0",marginBottom:4}}>반응 지연 (Latency)</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
            <span style={{fontSize:18,fontWeight:800,color:latency===0?"#3de090":latency<30?"#f0c040":"#f05050"}}>
              {latency}
            </span>
            <span style={{fontSize:10,color:"#3a5870"}}>프레임 지연</span>
          </div>
          <div style={{background:"rgba(255,255,255,0.06)",borderRadius:99,height:5,marginBottom:3}}>
            <div style={{height:"100%",borderRadius:99,width:(latency/55*100)+"%",background:latency===0?"#3de090":latency<30?"#f0c040":"#f05050",transition:"width 0.4s"}}/>
          </div>
          <div style={{fontSize:9,color:"#2a4860",marginBottom:10}}>
            Nilsson et al. (2012): 산성화 시 위험 감지 후 반응 지연
          </div>

          {/* 지연 중 개체 */}
          {waitingN>0&&(
            <div style={{padding:"5px 9px",borderRadius:6,background:"rgba(220,200,50,0.1)",border:"1px solid rgba(220,200,50,0.25)",fontSize:10.5,color:"#d4c040",marginBottom:10}}>
              ⏳ 반응 지연 중: <b>{waitingN}마리</b>
            </div>
          )}

          {/* 생존 */}
          <div style={{fontSize:10.5,color:"#5a8aa0",marginBottom:5}}>생존 현황</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:6}}>
            <div><span style={{fontSize:24,fontWeight:800,color:srColor}}>{aliveN}</span>
              <span style={{fontSize:11,color:"#385868",marginLeft:2}}>/ {INIT_COUNT}</span></div>
            <span style={{fontSize:17,fontWeight:800,color:srColor}}>{survRate}%</span>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:2,marginBottom:7}}>
            {fish.map((f,i)=>(
              <span key={i} style={{fontSize:12,opacity:f.alive?1:0.13,transition:"opacity 0.5s"}}>🐠</span>
            ))}
          </div>
          <svg width={cW} height={cH} style={{display:"block"}}>
            <rect width={cW} height={cH} rx="3" fill="rgba(255,255,255,0.02)"/>
            <line x1={0} y1={cH/2} x2={cW} y2={cH/2} stroke="rgba(50,110,170,0.09)" strokeDasharray="3 3"/>
            {survLog.length>1&&<polyline points={chartPts} fill="none" stroke={srColor} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>}
          </svg>
        </div>

        <div style={{display:"flex",gap:8}}>
          <button onClick={reset} style={{flex:1,padding:"9px 0",borderRadius:9,border:"none",background:"rgba(50,110,170,0.13)",color:"#5aa8ca",fontWeight:700,fontSize:12,cursor:"pointer",outline:"1px solid rgba(50,110,170,0.24)"}}>
            ↺ 초기화
          </button>
        </div>

        <div style={{fontSize:9.5,color:"#2a4860",lineHeight:1.7}}>
          <b style={{color:"#5a8aa0"}}>Dixson et al. (2010)</b> — GABA<sub>A</sub> 역전<br/>
          <b style={{color:"#5a8aa0"}}>Nilsson et al. (2012)</b> — 반응 지연<br/>
          🟡 지연 중 &nbsp; 🟢 회피 중 &nbsp; 🔴 유인 중 (역전)<br/>
          ⚪ 회색 글로우: 후각 상실 (셧다운 → 표류)
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 메인 앱 — 두 페이지 탭
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab, setTab] = useState(0);
  const [pH, setPH] = useState(8.15);
  const col = phToCol(pH);

  return (
    <div style={{
      minHeight:"100vh",
      background:"linear-gradient(155deg,#020c18 0%,#051525 55%,#030e1c 100%)",
      fontFamily:"'Segoe UI',system-ui,sans-serif",
      color:"#b8d4e8",
      display:"flex",flexDirection:"column",alignItems:"center",
      padding:"20px 10px 36px",
    }}>
      <style>{`
        @keyframes gabaBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        .gaba-reversal { animation: gabaBlink 0.9s ease-in-out infinite; }
      `}</style>
      {/* 헤더 */}
      <div style={{textAlign:"center",marginBottom:16,maxWidth:760}}>
        <div style={{fontSize:10,letterSpacing:3.5,color:"#336a90",textTransform:"uppercase",marginBottom:6}}>
          Ocean Acidification · Behavioral Impact Simulation
        </div>
        <h1 style={{margin:0,fontSize:"clamp(15px,2.8vw,22px)",fontWeight:700,color:"#d8ecfa",lineHeight:1.2}}>
          해양 산성화와 흰동가리 행동 변화
        </h1>
        <p style={{margin:"7px 0 0",fontSize:11.5,color:"#5a90ae",lineHeight:1.65}}>
          Munday et al. (2009) · Dixson et al. (2010) · Nilsson et al. (2012)
        </p>
      </div>

      {/* pH 슬라이더 (공유) */}
      <div style={{
        background:"rgba(5,16,32,0.95)",border:"1px solid "+col+"45",
        borderRadius:11,padding:"12px 20px",marginBottom:16,
        width:"100%",maxWidth:480,boxShadow:"0 0 16px "+col+"10",
      }}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <span style={{fontSize:11,color:"#3a7898",fontWeight:600,letterSpacing:1}}>해수 pH (변경 시 노출일수 리셋)</span>
          <span style={{fontSize:26,fontWeight:800,color:col}}>{pH.toFixed(2)}</span>
        </div>
        <input type="range" min="7.60" max="8.15" step="0.05" value={pH}
          onChange={e=>setPH(parseFloat(e.target.value))}
          style={{width:"100%",accentColor:col,cursor:"pointer",marginBottom:5}}/>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:9.5,color:"#285060"}}>
          <span>7.60 극산성</span><span>8.15 현재</span>
        </div>
      </div>

      {/* 탭 */}
      <div style={{display:"flex",gap:6,marginBottom:18,background:"rgba(5,16,32,0.8)",borderRadius:10,padding:4}}>
        {["귀소 능력 — 말미잘 찾아가기","포식자 회피 — 생존율"].map((label,i)=>(
          <button key={i} onClick={()=>setTab(i)} style={{
            padding:"9px 20px",borderRadius:8,border:"none",cursor:"pointer",
            background:tab===i?"rgba(50,110,170,0.35)":"transparent",
            color:tab===i?"#a0d0f0":"#4a7898",
            fontWeight:tab===i?700:400,fontSize:12.5,
            outline:tab===i?"1px solid rgba(50,110,170,0.4)":"none",
            transition:"all 0.2s",
          }}>
            {i===0?"① ":"② "}{label}
          </button>
        ))}
      </div>

      {/* 시뮬레이션 */}
      {tab===0 ? <HomingPage pH={pH} onPHChange={setPH}/> : <PredatorPage pH={pH} onPHChange={setPH}/>}

      {/* 하단 범례 */}
      <div style={{marginTop:18,fontSize:10,color:"#1c3848",textAlign:"center",lineHeight:1.8}}>
        {tab===0
          ?"귀소 모델: 3×2 대칭 배치 · 순환 화면(토러스) · 선호도 비례 확률 정착 · Munday et al. (2009) PNAS"
          :"포식자 반응 모델: GABAA 역전 (Dixson 2010) · 반응 지연 latency (Nilsson 2012) · 개체별 감수성 편차"
        }
      </div>
    </div>
  );
}
