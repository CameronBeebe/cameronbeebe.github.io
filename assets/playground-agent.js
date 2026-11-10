const maxSpeed = 1.5;
const spring = 0.0024;
const damping = 0.978;
const still = { x: 0, y: 0 };
const goalSensorRange = 52;
const observationTicks = 18;
const refinementTicks = 36;

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
    Object.assign(state, { position: center, estimate: center, goals: [], attractor: null, planning: false, done: 0, misses: 0, trail: [] });
    velocity = still;
    rememberedCurrent = still;
  }

  function advance(point, current, strength) {
    return boundPoint(
      point.x + velocity.x + current.x * strength,
      point.y + velocity.y + current.y * strength,
    );
  }

  function boundPoint(x, y, inset = 12) {
    return {
      x: Math.max(inset, Math.min(width - inset, x)),
      y: Math.max(inset, Math.min(height - inset, y)),
    };
  }

  function readPosition() {
    const { x, y } = state.position;
    return boundPoint(x + 1.1 + 3.4 * Math.sin((x + 2 * y) / 47),
      y - 0.7 + 3.1 * Math.cos((2 * x - y) / 49));
  }

  function observeGoal(target, scale) {
    // Sample by area in a disk. In this model, planning reduces the same reading's error.
    const angle = Math.random() * 2 * Math.PI;
    const magnitude = Math.sqrt(Math.random()) * scale;
    const dx = Math.cos(angle) * magnitude;
    const dy = Math.sin(angle) * magnitude;
    function reading(radius) {
      // The goal estimate can sit closer to the print's edge than the agent can travel.
      const center = boundPoint(target.x + dx * radius, target.y + dy * radius, 4);
      return { ...center, radius: Math.ceil(scale * radius) };
    }
    return { reported: reading(35), planned: reading(11) };
  }

  function addGoal(target, life) {
    target.age = 0;
    target.observation = observeGoal(target, 1);
    target.belief = target.observation.reported;
    target.refinement = { to: target.belief, tick: refinementTicks };
    state.goals = state.goals.filter(goal => goal.target.cell !== target.cell);
    state.goals.push({ target, life });
  }

  function refineGoal(target, plan) {
    const observation = target.localReading ?? target.observation;
    const reading = target.verified ?? (plan ? observation.planned : observation.reported);
    if (target.refinement.to !== reading) {
      target.refinement = { from: target.belief, to: reading, tick: 0 };
    }
    const change = target.refinement;
    if (change.tick === refinementTicks) return;
    const progress = ++change.tick / refinementTicks;
    const weight = progress * progress * (3 - 2 * progress);
    const { from, to } = change;
    target.belief = progress === 1 ? to : {
      x: from.x + (to.x - from.x) * weight,
      y: from.y + (to.y - from.y) * weight,
      radius: from.radius + (to.radius - from.radius) * weight,
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
      state.estimate = readPosition();
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
    const { tools: feedback, memory, plan } = options;
    state.planning = false;
    const targets = new Set(visibleTargets);
    for (const { target } of state.goals) targets.add(target);
    if (state.attractor) targets.add(state.attractor);
    for (const target of targets) {
      target.age++;
      const observed = target.age > observationTicks;
      const planning = plan && target.age <= observationTicks + refinementTicks;
      const actualDistance = distanceBetween(target, state.position);
      if (feedback && observed && !planning && !target.localReading && actualDistance <= goalSensorRange) {
        target.localReading = observeGoal(target, 0.22);
      }
      refineGoal(target, plan && observed);
      if (!target.reached && actualDistance <= arrivalRadius) {
        target.reached = true;
        state.done++;
      }
    }

    if (feedback) state.estimate = readPosition();

    state.goals = state.goals.filter(goal => --goal.life > 0);
    let pending;
    let distance = Infinity;
    for (const goal of state.goals) {
      const gap = distanceBetween(goal.target.belief, state.estimate);
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
    state.planning = Boolean(pending && plan && target.age <= observationTicks + refinementTicks);
    if (state.planning || (target.verified && target.belief !== target.verified)) {
      velocity = still;
      return;
    }
    const aim = target.belief;
    const dx = aim.x - state.estimate.x;
    const dy = aim.y - state.estimate.y;

    // After a failed check, aim closer to the verified center before stopping again.
    if (pending && distance <= (target.verified ? 2 : arrivalRadius)) {
      if (!target.reached) {
        target.falseArrival = true;
        state.misses++;
        if (options.verifier) {
          // The independent arrival check supplies a fix for both positions.
          state.estimate = state.position;
          target.verified ??= { x: target.x, y: target.y, radius: 2 };
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
  return { state, step, reset, addGoal };
}
