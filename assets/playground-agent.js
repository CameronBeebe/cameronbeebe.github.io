const speed = 1.6;
const reach = 8;
const still = { x: 0, y: 0 };

export function createAgent(kind, width, height) {
  const harnessed = kind === 'harness';
  const state = { kind };
  let velocity;
  let rememberedCurrent;

  function reset() {
    const center = { x: width / 2, y: height / 2 };
    Object.assign(state, { position: center, estimate: center, goals: [], done: 0, misses: 0, trail: [] });
    velocity = still;
    rememberedCurrent = still;
  }

  function advance(point, current, strength) {
    return {
      x: Math.max(12, Math.min(width - 12, point.x + velocity.x + current.x * strength)),
      y: Math.max(12, Math.min(height - 12, point.y + velocity.y + current.y * strength)),
    };
  }

  function move(feedback, memory, strength = 1) {
    const { x, y } = state.position;
    // Both agents move in the same position-dependent cross-current.
    const current = { x: 0.5 + 0.16 * Math.cos(y / 50), y: 0.4 * Math.sin(x / 75) };
    state.position = advance(state.position, current, strength);
    if (feedback) {
      state.estimate = state.position;
      if (memory) rememberedCurrent = current;
    } else {
      state.estimate = advance(state.estimate, memory ? rememberedCurrent : still, strength);
    }
  }

  function step(options) {
    const feedback = harnessed && options.tools;
    const memory = harnessed && options.memory;
    if (feedback) state.estimate = state.position;

    state.goals = state.goals.filter(goal => --goal.life > 0);
    let target;
    let distance = Infinity;
    for (const goal of state.goals) {
      const gap = Math.hypot(goal.x - state.estimate.x, goal.y - state.estimate.y);
      if (gap < distance) {
        target = goal;
        distance = gap;
      }
    }

    if (!target) {
      const strength = Math.hypot(velocity.x, velocity.y) / speed;
      if (harnessed && !options.stop && strength > 0.02) {
        move(feedback, memory, strength);
        velocity = { x: velocity.x * 0.95, y: velocity.y * 0.95 };
      } else {
        velocity = still;
      }
      return;
    }

    if (distance > reach) {
      const predicted = memory ? rememberedCurrent : still;
      velocity = {
        x: (target.x - state.estimate.x) * speed / distance - predicted.x,
        y: (target.y - state.estimate.y) * speed / distance - predicted.y,
      };
      move(feedback, memory);
      return;
    }

    const reached = Math.hypot(target.x - state.position.x, target.y - state.position.y) <= reach;
    if (!reached) {
      state.misses++;
      velocity = still;
      if (harnessed && options.verifier) {
        // The arrival check supplies a fresh position even if live feedback is off.
        state.estimate = state.position;
        return;
      }
    }

    state.goals.splice(state.goals.indexOf(target), 1);
    if (!harnessed || options.stop) velocity = still;
    if (reached) {
      state.done++;
      return target;
    }
  }

  reset();
  return { state, step, reset };
}
