const maxSpeed = 1.5;
const spring = 0.0024;
const damping = 0.978;
const reach = 8;
const still = { x: 0, y: 0 };

export function createAgent(kind, width, height) {
  const harnessed = kind === 'harness';
  const state = { kind };
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

  function move(feedback, memory) {
    const { x, y } = state.position;
    // Both agents move in the same position-dependent cross-current.
    const current = { x: 0.5 + 0.16 * Math.cos(y / 50), y: 0.4 * Math.sin(x / 75) };
    const predicted = memory ? rememberedCurrent : still;
    const slip = { x: current.x - predicted.x, y: current.y - predicted.y };
    const strength = Math.min(1, Math.hypot(velocity.x, velocity.y) / 2);
    state.position = advance(state.position, slip, strength);
    if (feedback) {
      state.estimate = state.position;
      if (memory) rememberedCurrent = current;
    } else {
      state.estimate = advance(state.estimate, still, 0);
    }
  }

  function step(options) {
    const feedback = harnessed && options.tools;
    const memory = harnessed && options.memory;
    if (feedback) state.estimate = state.position;

    state.goals = state.goals.filter(goal => --goal.life > 0);
    let pending;
    let distance = Infinity;
    for (const goal of state.goals) {
      const gap = Math.hypot(goal.x - state.estimate.x, goal.y - state.estimate.y);
      if (gap < distance) {
        pending = goal;
        distance = gap;
      }
    }

    if (pending || !feedback) state.attractor = null;
    const target = pending ?? state.attractor;
    if (!target) {
      velocity = still;
      return;
    }
    const dx = target.x - state.estimate.x;
    const dy = target.y - state.estimate.y;

    if (pending && distance <= reach) {
      const reached = Math.hypot(target.x - state.position.x, target.y - state.position.y) <= reach;
      if (reached) state.done++;
      else {
        state.misses++;
        if (harnessed && options.verifier) {
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
      // Execute the imagined movement once, without correcting for the real drift.
      velocity = { x: dx * maxSpeed / distance, y: dy * maxSpeed / distance };
      move(false, memory);
      return;
    }

    // Live position feedback drives a spring controller. Damping removes momentum each tick.
    const retention = options.damp ? damping : 1;
    const vx = velocity.x * retention + dx * spring;
    const vy = velocity.y * retention + dy * spring;
    const scale = Math.min(1, maxSpeed / Math.hypot(vx, vy));
    velocity = { x: vx * scale, y: vy * scale };
    move(true, memory);
  }

  reset();
  return { state, step, reset };
}
