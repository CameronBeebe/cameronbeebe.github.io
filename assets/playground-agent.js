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
  let learnedCurrent;

  function reset() {
    const center = { x: width / 2, y: height / 2 };
    Object.assign(state, { position: center, estimate: center, goals: [], focusedGoal: null, settling: false, planning: false, done: 0, misses: 0, trail: [] });
    velocity = still;
    learnedCurrent = still;
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

  function focusGoal(target) {
    state.focusedGoal = target;
    state.settling = false;
    velocity = still;
  }

  function addGoal(target) {
    target.age = 0;
    target.observation = observeGoal(target, 1);
    target.belief = target.observation.reported;
    target.refinement = { to: target.belief, tick: refinementTicks };
    state.goals = state.goals.filter(goal => goal.cell !== target.cell);
    state.goals.push(target);
    focusGoal(target);
  }

  function forgetQueuedGoals() {
    const forgotten = state.goals.filter(goal => goal !== state.focusedGoal);
    state.goals = state.goals.filter(goal => goal === state.focusedGoal);
    return forgotten;
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

  function move(feedback, plan) {
    const current = currentAt(state.position);
    // The plan forecasts a weaker current at the estimated position.
    const forecast = plan ? currentAt(state.estimate, 0.75) : still;
    const correction = plan ? {
      x: 0.65 * forecast.x + 0.35 * learnedCurrent.x,
      y: 0.65 * forecast.y + 0.35 * learnedCurrent.y,
    } : still;
    const slip = { x: current.x - correction.x, y: current.y - correction.y };
    const strength = Math.min(1, Math.hypot(velocity.x, velocity.y) / 2);
    state.position = advance(state.position, slip, strength);
    if (feedback) {
      state.estimate = readPosition();
      if (plan) {
        // Use recent readings to anticipate the current as it changes across the print.
        learnedCurrent = {
          x: learnedCurrent.x + 0.07 * (current.x - learnedCurrent.x),
          y: learnedCurrent.y + 0.07 * (current.y - learnedCurrent.y),
        };
      }
    } else {
      const expectedSlip = plan ? { x: forecast.x - correction.x, y: forecast.y - correction.y } : still;
      state.estimate = advance(state.estimate, expectedSlip, strength);
    }
  }

  function scoreArrival(target) {
    if (!target.reached && distanceBetween(target, state.position) <= arrivalRadius) {
      target.reached = true;
      state.done++;
    }
  }

  function step(options) {
    const { tools: feedback, plan } = options;
    state.planning = false;
    if (feedback) state.estimate = readPosition();

    let target = state.focusedGoal;
    if (!target) return;
    scoreArrival(target);
    if (state.goals.length > 1) {
      for (const goal of state.goals) scoreArrival(goal);
      state.goals = state.goals.filter(goal => goal === target || !goal.reached);
    }
    if (state.goals.length && !state.goals.includes(target)) {
      let nearestDistance = Infinity;
      for (const goal of state.goals) {
        const gap = distanceBetween(goal.belief, state.estimate);
        if (gap < nearestDistance) {
          target = goal;
          nearestDistance = gap;
        }
      }
      focusGoal(target);
    }

    const pending = state.goals.includes(target);
    target.age++;
    const observed = target.age > observationTicks;
    state.planning = pending && plan && target.age <= observationTicks + refinementTicks;
    if (feedback && observed && !state.planning && !target.localReading && distanceBetween(target, state.position) <= goalSensorRange) {
      target.localReading = observeGoal(target, 0.22);
    }
    refineGoal(target, plan && observed);

    if (!pending && (!feedback || !state.settling)) {
      state.settling = false;
      velocity = still;
      return;
    }
    if (state.planning || (target.verified && target.belief !== target.verified)) {
      velocity = still;
      return;
    }
    const aim = boundPoint(target.belief.x, target.belief.y);
    const dx = aim.x - state.estimate.x;
    const dy = aim.y - state.estimate.y;
    const distance = Math.hypot(dx, dy);

    // After a failed check, aim closer to the verified center before stopping again.
    if (pending && distance <= (target.verified && !target.reached ? 2 : arrivalRadius)) {
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

      state.goals.splice(state.goals.indexOf(target), 1);
      state.settling = feedback && state.goals.length === 0;
      if (!state.settling) {
        velocity = still;
        return;
      }
    } else if (!pending && options.stop && distance < 2
      && Math.hypot(velocity.x, velocity.y) < 0.08) {
      state.settling = false;
      velocity = still;
      return;
    }

    if (!feedback) {
      // Steer from the estimate when live position readings are unavailable.
      velocity = { x: dx * maxSpeed / distance, y: dy * maxSpeed / distance };
      move(false, plan);
      return;
    }

    // Live position feedback drives a spring controller. Damping removes momentum each tick.
    const retention = options.damp ? damping : 1;
    const vx = velocity.x * retention + dx * spring;
    const vy = velocity.y * retention + dy * spring;
    const scale = Math.min(1, maxSpeed / Math.hypot(vx, vy));
    velocity = { x: vx * scale, y: vy * scale };
    move(true, plan);
  }

  reset();
  return { state, step, reset, addGoal, forgetQueuedGoals };
}
