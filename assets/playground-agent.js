const maxSpeed = 1.5;
const spring = 0.0024;
const damping = 0.978;
const still = { x: 0, y: 0 };

export const arrivalRadius = 8;

export function distanceBetween(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function createAgent(width, height) {
  const state = {};
  let velocity;
  let rememberedCurrent;

  function reset() {
    const center = { x: width / 2, y: height / 2 };
    Object.assign(state, { position: center, estimate: center, goals: [], attractor: null, done: 0, misses: 0, trail: [] });
    velocity = still;
    rememberedCurrent = still;
  }

  function advance(point, current, strength) {
    return {
      x: Math.max(12, Math.min(width - 12, point.x + velocity.x + current.x * strength)),
      y: Math.max(12, Math.min(height - 12, point.y + velocity.y + current.y * strength)),
    };
  }

  function currentAt({ x, y }, scale = 1) {
    return {
      x: scale * 1.02 * Math.sin((y - height / 2) / 18 + (x - width / 2) / 57),
      y: scale * 1.02 * Math.cos((x - width / 2) / 19 - (y - height / 2) / 52),
    };
  }

  function move(feedback, memory, plan) {
    const current = currentAt(state.position);
    const remembered = memory ? rememberedCurrent : still;
    // The plan forecasts a weaker current at the estimated position.
    const forecast = plan ? currentAt(state.estimate, 0.75) : still;
    const correction = plan ? {
      x: 0.65 * forecast.x + 0.35 * remembered.x,
      y: 0.65 * forecast.y + 0.35 * remembered.y,
    } : remembered;
    const slip = { x: current.x - correction.x, y: current.y - correction.y };
    const strength = Math.min(1, Math.hypot(velocity.x, velocity.y) / 2);
    state.position = advance(state.position, slip, strength);
    if (feedback) {
      state.estimate = state.position;
      if (memory) {
        // Use recent readings to anticipate the current as it changes across the print.
        rememberedCurrent = {
          x: rememberedCurrent.x + 0.07 * (current.x - rememberedCurrent.x),
          y: rememberedCurrent.y + 0.07 * (current.y - rememberedCurrent.y),
        };
      }
    } else {
      const expectedSlip = plan ? { x: forecast.x - correction.x, y: forecast.y - correction.y } : still;
      state.estimate = advance(state.estimate, expectedSlip, strength);
    }
  }

  function step(options, visibleTargets) {
    for (const target of visibleTargets) {
      if (target.reached || distanceBetween(target, state.position) > arrivalRadius) continue;
      target.reached = true;
      state.done++;
    }

    const { tools: feedback, memory, plan } = options;
    if (feedback) state.estimate = state.position;

    state.goals = state.goals.filter(goal => --goal.life > 0);
    let pending;
    let distance = Infinity;
    for (const goal of state.goals) {
      const gap = distanceBetween(goal.target, state.estimate);
      if (gap < distance) {
        pending = goal;
        distance = gap;
      }
    }

    if (pending || !feedback) state.attractor = null;
    const target = pending?.target ?? state.attractor;
    if (!target) {
      velocity = still;
      return;
    }
    const dx = target.x - state.estimate.x;
    const dy = target.y - state.estimate.y;

    if (pending && distance <= arrivalRadius) {
      if (!target.reached) {
        state.misses++;
        if (options.verifier) {
          // Check the actual position on arrival and retry from that reading.
          state.estimate = state.position;
          velocity = still;
          return;
        }
      }

      state.goals.splice(state.goals.indexOf(pending), 1);
      if (!feedback) {
        velocity = still;
        return;
      }
      state.attractor = target;
    } else if (!pending && options.stop && Math.hypot(dx, dy) < 2
      && Math.hypot(velocity.x, velocity.y) < 0.08) {
      state.attractor = null;
      velocity = still;
      return;
    }

    if (!feedback) {
      // Steer from the estimate when live position readings are unavailable.
      velocity = { x: dx * maxSpeed / distance, y: dy * maxSpeed / distance };
      move(false, memory, plan);
      return;
    }

    // Live position feedback drives a spring controller. Damping removes momentum each tick.
    const retention = options.damp ? damping : 1;
    const vx = velocity.x * retention + dx * spring;
    const vy = velocity.y * retention + dy * spring;
    const scale = Math.min(1, maxSpeed / Math.hypot(vx, vy));
    velocity = { x: vx * scale, y: vy * scale };
    move(true, memory, plan);
  }

  reset();
  return { state, step, reset };
}
