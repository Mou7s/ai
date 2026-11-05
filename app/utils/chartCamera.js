export const initialCamera = () => ({
  eye: { x: 1.65, y: 1.65, z: 1.1 },
  up: { x: 0, y: 0, z: 1 },
  center: { x: 0, y: 0, z: 0 },
  projection: { type: 'perspective' }
});

export const planeViews = {
  '1': { eye: { x: 0, y: 1.95, z: 0 }, up: { x: 0, y: 0, z: 1 }, hidden: 'yaxis', hiddenIdx: 1 },
  '2': { eye: { x: 1.95, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, hidden: 'xaxis', hiddenIdx: 0 },
  '3': { eye: { x: 0, y: 0, z: 1.95 }, up: { x: 0, y: -1, z: 0 }, hidden: 'zaxis', hiddenIdx: 2 }
};

export const viewCamera = (view = '4') => view === '4' ? initialCamera() : {
  eye: { ...planeViews[view].eye },
  up: { ...planeViews[view].up },
  center: { x: 0, y: 0, z: 0 },
  projection: { type: 'perspective' }
};

export const vecSub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
export const vecDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vecCross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
export const vecNorm = v => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-8 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
};

export function orthoUp(upVec, dirVec) {
  const dot = vecDot(upVec, dirVec);
  const proj = [upVec[0] - dot * dirVec[0], upVec[1] - dot * dirVec[1], upVec[2] - dot * dirVec[2]];
  const len = Math.hypot(proj[0], proj[1], proj[2]);
  if (len > 1e-6) return [proj[0] / len, proj[1] / len, proj[2] / len];
  const fallback = Math.abs(dirVec[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  return orthoUp(fallback, dirVec);
}

export function rotateAroundAxis(v, axis, angle) {
  if (Math.abs(angle) < 1e-8) return v;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kDotV = vecDot(axis, v);
  const kCrossV = vecCross(axis, v);
  return [
    v[0] * c + kCrossV[0] * s + axis[0] * kDotV * (1 - c),
    v[1] * c + kCrossV[1] * s + axis[1] * kDotV * (1 - c),
    v[2] * c + kCrossV[2] * s + axis[2] * kDotV * (1 - c)
  ];
}

export function interpolateCamera(from, to, t) {
  const center = {
    x: from.center.x + (to.center.x - from.center.x) * t,
    y: from.center.y + (to.center.y - from.center.y) * t,
    z: from.center.z + (to.center.z - from.center.z) * t
  };
  const v0 = vecSub(from.eye, from.center);
  const v1 = vecSub(to.eye, to.center);
  const r0 = Math.hypot(...v0) || 1.9;
  const r1 = Math.hypot(...v1) || 1.9;
  const radius = r0 + (r1 - r0) * t;

  const d0 = [v0[0] / r0, v0[1] / r0, v0[2] / r0];
  const d1 = [v1[0] / r1, v1[1] / r1, v1[2] / r1];
  const cosOmega = Math.max(-1, Math.min(1, vecDot(d0, d1)));
  let omega = Math.acos(cosOmega);
  let rotAxis = vecCross(d0, d1);
  const axisLen = Math.hypot(...rotAxis);
  if (axisLen > 1e-6) {
    rotAxis = [rotAxis[0] / axisLen, rotAxis[1] / axisLen, rotAxis[2] / axisLen];
  } else if (cosOmega < 0) {
    rotAxis = orthoUp([0, 0, 1], d0);
    omega = Math.PI;
  } else {
    rotAxis = [0, 0, 1];
    omega = 0;
  }

  const dir = rotateAroundAxis(d0, rotAxis, omega * t);
  const u0 = orthoUp([from.up.x, from.up.y, from.up.z], d0);
  const u1 = orthoUp([to.up.x, to.up.y, to.up.z], d1);
  // Parallel-transport u0 along the sightline arc to d1, then measure twist angle to u1.
  const u0AtEnd = orthoUp(rotateAroundAxis(u0, rotAxis, omega), d1);
  const twistCos = Math.max(-1, Math.min(1, vecDot(u0AtEnd, u1)));
  const twistSin = vecDot(d1, vecCross(u0AtEnd, u1));
  const twistAngle = Math.atan2(twistSin, twistCos);
  const uCarried = rotateAroundAxis(u0, rotAxis, omega * t);
  const upArr = vecNorm(rotateAroundAxis(uCarried, dir, twistAngle * t));

  return {
    center,
    eye: {
      x: center.x + dir[0] * radius,
      y: center.y + dir[1] * radius,
      z: center.z + dir[2] * radius
    },
    up: { x: upArr[0], y: upArr[1], z: upArr[2] },
    projection: { type: 'perspective' }
  };
}
