# /// script
# requires-python = ">=3.12"
# dependencies = ["dspy==3.5.0", "pillow==13.0.0", "litellm==1.109.1"]
# ///
"""Actual DSPy GEPA optimization, using the same JS engine as the deployed demo.

Run with: uv run ask-worker/optimize-ascii.py --out /private/tmp/ascii-gepa
Credentials come only from OPENROUTER_API_KEY / TYPESAFE_API_KEY in the environment.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

import dspy
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ALPHABET = " .,:;*oxO%#@"


class Engine:
    def __init__(self):
        self.process = subprocess.Popen(["node", "ask-worker/ascii-offline.mjs"], cwd=ROOT,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.info = self.call({"operation": "info"})

    def call(self, payload):
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("The shared ASCII engine stopped.")
        value = json.loads(line)
        if "error" in value:
            raise RuntimeError(value["error"])
        return value

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)


def render(rows):
    # Same dimensions, glyph ramp and ink colors as the browser; Pillow/Menlo is
    # an approximation of the browser's font rasterization, not an exact screenshot.
    scale = 4
    image = Image.new("RGB", (375 * scale, 375 * scale), "#031803")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(os.environ.get("ASCII_EVAL_FONT", "/System/Library/Fonts/Menlo.ttc"), round(7.5 * 13 / 12 * scale))
    inks = ["#246321", "#389b2d", "#59cf48", "#39ff14"]
    for y, row in enumerate(rows):
        for x, char in enumerate(row):
            if char != " ":
                color = inks[round(ALPHABET.index(char) * 3 / 11)]
                draw.text(((x + .5) * 5 * scale, (y + .5) * 7.5 * scale), char,
                          font=font, fill=color, anchor="mm")
    output = io.BytesIO()
    image.resize((375, 375), Image.Resampling.LANCZOS).save(output, format="PNG")
    return output.getvalue()


def judge(brief, rows, rubrics):
    ref = str(uuid.uuid4())
    png = render(rows)
    payload = {"model": "jev-latest", "state": {"brief": brief, "artwork": ref},
               "assets": {ref: {"type": "image", "format": "png", "data_base64": base64.b64encode(png).decode()}},
               "questions": {key: {"type": "score", "instructions": rubric["instructions"], "criteria": rubric["criteria"]}
                             for key, rubric in rubrics.items()}}
    request = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + os.environ["TYPESAFE_API_KEY"], "Content-Type": "application/json",
                 "TypeSafe-Danger-Zone-Images": "true"})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    for key in rubrics:
        answer = result["answers"][key]
        probabilities = list(answer["probabilities"].values())
        if answer.get("type") != "score" or not 0 <= answer["score"] <= 3 or len(probabilities) != 4 or abs(sum(probabilities) - 1) > .01:
            raise RuntimeError("Invalid Jev judgment; optimization was stopped.")
    return result


class Drawing(dspy.Signature):
    """Compose a recognizable subject with clear silhouette, defining features, intentional shading, and negative space."""
    brief: str = dspy.InputField()
    harness: str = dspy.InputField(desc="Fixed switches. Optimize composition only; preserve output format, tools, alphabet, dimensions, budget, and feedback semantics. The strategy must work for both direct output and tool mode.")
    run_json: str = dspy.OutputField(desc="The generation engine's complete run record.")


class CompositionProposal(dspy.Signature):
    """Improve only VISUAL COMPOSITION advice for an ASCII artist using trial evidence.
    Output a concise general strategy for silhouette, defining features, spatial layout,
    negative space, texture, and tonal hierarchy. Do not copy a complete system prompt.
    Never mention tools, functions, JSON, schemas, feedback settings, budgets, dimensions,
    or exact line lengths: those are fixed elsewhere and have separate user switches.
    Do not draw sample artwork or overfit the advice to the example subjects.
    """
    current_advice: str = dspy.InputField()
    trial_evidence: str = dspy.InputField()
    scope_feedback: str = dspy.InputField()
    advice: str = dspy.OutputField()


class GridAdapter(dspy.Adapter):
    """Translate a DSPy predictor to the existing JS engine rather than changing
    the deployed task's output framing through DSPy's default text adapter.
    GEPA changes signature.instructions; all rendering/tool/validation code stays fixed.
    """
    def __init__(self, engine, model, out):
        super().__init__()
        self.engine, self.model, self.out = engine, model, out
        self.counter = max([int(path.stem.split("-")[-1]) for path in out.glob("generation-*.json")] or [0])

    def __deepcopy__(self, memo):
        # Candidate programs share the one serial evaluation engine, not child processes.
        return self

    def __call__(self, lm, lm_kwargs, signature, demos, inputs):
        if demos:
            raise ValueError("This experiment optimizes instructions, not demonstrations.")
        self.counter += 1
        print(f"Generation {self.counter}: {inputs['brief']}", flush=True)
        run = self.engine.call({"brief": inputs["brief"], "harness": json.loads(inputs["harness"]),
                                "model": self.model, "instructions": signature.instructions})
        run.update(brief=inputs["brief"], harness=json.loads(inputs["harness"]), instructions=signature.instructions)
        (self.out / f"generation-{self.counter:03d}.json").write_text(json.dumps(run, indent=2))
        return [{"run_json": json.dumps(run)}]


class Program(dspy.Module):
    def __init__(self, adapter, baseline):
        super().__init__()
        self.draw = dspy.Predict(Drawing.with_instructions(baseline))
        self.adapter = adapter

    def forward(self, brief, harness):
        with dspy.context(adapter=self.adapter):
            return self.draw(brief=brief, harness=harness)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default="qwen/qwen3.6-35b-a3b")
    parser.add_argument("--budget", type=int, default=14)
    parser.add_argument("--resume", action="store_true", help="Reuse recorded GEPA search, then finish validation/export.")
    parser.add_argument("--publish", action="store_true", help="Export the selected prompt to assets/ascii-prompts.json after evaluation.")
    args = parser.parse_args()
    for key in ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"]:
        if not os.environ.get(key):
            raise RuntimeError(f"Set {key} in a private environment; never pass it as a command argument.")
    args.out.mkdir(parents=True, exist_ok=True)
    engine = Engine()
    adapter = GridAdapter(engine, args.model, args.out)
    records = json.loads((args.out / "metrics.json").read_text()) if args.resume and (args.out / "metrics.json").exists() else []
    metric_cache = {}
    proposals = json.loads((args.out / "proposals.json").read_text()) if args.resume else []

    def metric(gold, prediction, trace=None, pred_name=None, pred_trace=None):
        if prediction.run_json in metric_cache:
            return metric_cache[prediction.run_json]
        run = json.loads(prediction.run_json)
        final = run["drafts"][-1] if run["drafts"] else {}
        result = {"brief": gold.brief, "harness": json.loads(gold.harness), "instructions": run["instructions"],
                  "valid": bool(final.get("valid")), "score": 0., "judgment": None}
        if not final.get("valid"):
            feedback = "The run failed to submit a valid grid. " + json.dumps({"errors": final.get("errors", final.get("reason")), "toolFailures": [call["observation"]["rejected"][:3] for draft in run["drafts"][-2:] for call in draft.get("toolTrace", []) if call["observation"]["rejected"]]})
        elif not any(char != " " for row in final["rows"] for char in row):
            feedback = "The format passed but the artwork is entirely blank. Depict the brief visibly."
        else:
            result["judgment"] = judge(gold.brief, final["rows"], engine.info["asciiRubrics"])
            answers = result["judgment"]["answers"]
            result["score"] = (.8 * answers["match"]["score"] + .2 * answers["readability"]["score"]) / 3
            feedback = "Format passed. Fallible visual observations from Jev on a rendered grid: " + json.dumps({
                key: {"score": answers[key]["score"], "criteria": rubric["criteria"], "probabilities": answers[key]["probabilities"]}
                for key, rubric in engine.info["asciiRubrics"].items()})
        result["feedback"] = feedback
        records.append(result)
        (args.out / "metrics.json").write_text(json.dumps(records, indent=2))
        print(f"Metric {len(records)}: valid={result['valid']} score={result['score']:.3f}", flush=True)
        value = dspy.Prediction(score=result["score"], feedback=feedback)
        metric_cache[prediction.run_json] = value
        return value

    data = json.loads((ROOT / "ask-worker/dspy-briefs.json").read_text())
    def examples(name):
        return [dspy.Example(brief=case["brief"], harness=json.dumps({"tools": case["tools"], "guidance": case["guidance"],
            "feedback": case["feedback"], "optimized": False})).with_inputs("brief", "harness") for case in data[name]]
    lm = dspy.LM("openrouter/" + args.model, engine="litellm", api_base="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"],
        model_type="chat", max_tokens=8192, temperature=.7, num_retries=0, cache=False,
        extra_body={"reasoning": {"enabled": False}, "provider": {"max_price": {"prompt": .4, "completion": 1}}})
    dspy.configure(lm=lm)
    proposal_predictor = dspy.Predict(CompositionProposal)
    def propose(candidate, reflective_dataset, components_to_update):
        replacements = {}
        for component in components_to_update:
            evidence = []
            for sample in reflective_dataset.get(component, []):
                outputs = sample.get("Generated Outputs", {})
                try:
                    run = json.loads(outputs.get("run_json", "{}"))
                    final = run.get("drafts", [{}])[-1]
                    picture = final.get("rows", final.get("workspaceRows"))
                except (ValueError, IndexError, AttributeError):
                    picture = None
                evidence.append({"brief": sample.get("Inputs", {}).get("brief"),
                                 "artwork_rows": picture, "feedback": sample.get("Feedback", "")[:4500]})
            scope = "Only visual composition advice. No tool names, protocols, output-format instructions, dimensions, or turn limits."
            for attempt in range(2):
                prediction = proposal_predictor(current_advice=candidate[component], trial_evidence=json.dumps(evidence), scope_feedback=scope)
                advice = prediction.advice.strip()
                forbidden = [word for word in ["create_grid", "write_rows", "write_columns", "submit_grid", "json", "schema", "tool guidance", "tool call", "feedback toggle", "75", "50", "model turns"] if word in advice.lower()]
                proposals.append({"parent": candidate[component], "instructions": advice, "scopeViolations": forbidden, "evidence": evidence})
                (args.out / "proposals.json").write_text(json.dumps(proposals, indent=2))
                if advice and len(advice) <= 3000 and not forbidden:
                    replacements[component] = advice
                    break
                scope = "Rejected proposal: do not include these protocol concepts: " + ", ".join(forbidden) + ". Describe visual composition only, in fewer than 3000 characters."
            if component not in replacements:
                raise RuntimeError("Reflection could not produce an in-scope composition candidate.")
        return replacements

    baseline = Program(adapter, engine.info["baselineInstructions"])
    try:
        if args.resume:
            details = json.loads((args.out / "gepa-results.json").read_text())
        else:
            optimizer = dspy.GEPA(metric=metric, reflection_lm=lm, instruction_proposer=propose, max_metric_calls=args.budget,
                reflection_minibatch_size=2, num_threads=1, use_merge=False, track_stats=True,
                seed=42, log_dir=str(args.out / "gepa"))
            optimized = optimizer.compile(baseline, trainset=examples("practice"), valset=examples("validation"))
            details = optimized.detailed_results.to_dict()
            (args.out / "gepa-results.json").write_text(json.dumps(details, indent=2, default=str))
        candidates = list(details["candidates"])
        validation_scores = list(details["val_aggregate_scores"])
        parents = list(details["parents"])
        optimizer_best_index = max(range(len(validation_scores)), key=lambda i: validation_scores[i])
        extra_validation_runs = 0
        # GEPA may reject a mutation on its practice minibatch before full validation.
        # Fully evaluate those real proposals too, so the public toggle can compare a
        # changed candidate even when baseline remains the optimizer's overall winner.
        for proposal in proposals:
            advice = proposal["instructions"]
            if proposal["scopeViolations"] or any(candidate["draw"] == advice for candidate in candidates):
                continue
            program = Program(adapter, advice)
            scores = []
            for example in examples("validation"):
                prediction = program(**example.inputs())
                scores.append(metric(example, prediction).score)
                extra_validation_runs += 1
            parent = next((i for i, candidate in enumerate(candidates) if candidate["draw"] == proposal["parent"]), None)
            candidates.append({"draw": advice}); validation_scores.append(sum(scores) / len(scores)); parents.append([parent])
        changed = [i for i, candidate in enumerate(candidates) if candidate["draw"] != engine.info["baselineInstructions"]]
        if not changed:
            raise RuntimeError("No changed candidate was evaluated. No artifact was published.")
        selected_index = max(changed, key=lambda i: validation_scores[i])
        selected = Program(adapter, candidates[selected_index]["draw"])
        selected.save(str(args.out / "dspy-state.json"))
        held_out = []
        for label, program in [("baseline", baseline), ("selected", selected)]:
            for example in examples("heldOut"):
                prediction = program(**example.inputs())
                value = metric(example, prediction)
                held_out.append({"variant": label, "brief": example.brief, "score": value.score, "valid": records[-1]["valid"]})
        instructions = selected.draw.signature.instructions
        artifact = {"id": "gepa-" + hashlib.sha256(instructions.encode()).hexdigest()[:12], "status": "pilot",
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "optimizer": "DSPy GEPA", "dspyVersion": dspy.__version__,
            "model": args.model, "instructions": instructions, "baselineInstructions": engine.info["baselineInstructions"],
            "metric": "0 for invalid/blank; otherwise (0.8 × Jev brief match + 0.2 × coherence) / 3",
            "maxModelTurns": 8, "writeSemantics": "initial and incremental prefix writes preserve unaddressed cells",
            "engineSha256": hashlib.sha256((ROOT / "ask-worker/ascii.mjs").read_bytes() + (ROOT / "assets/ascii-workspace.mjs").read_bytes()).hexdigest(),
            "metricCalls": details.get("total_metric_calls"), "extraValidationRuns": extra_validation_runs, "validationScores": validation_scores,
            "candidates": candidates, "parents": parents,
            "selectedIndex": selected_index, "optimizerBestIndex": optimizer_best_index,
            "selection": "Best validation score among changed prompts. Baseline may still win overall; compare the recorded scores.", "heldOut": held_out,
            "datasetSha256": hashlib.sha256((ROOT / "ask-worker/dspy-briefs.json").read_bytes()).hexdigest(),
            "limitations": "Small single-run pilot; noisy uncalibrated image judge and approximate Pillow rendering. Training model Qwen; cross-model transfer and all switch combinations are untested. Not evidence of general superiority."}
        (args.out / "prompt.json").write_text(json.dumps(artifact, indent=2))
        if args.publish:
            (ROOT / "assets/ascii-prompts.json").write_text(json.dumps(artifact, indent=2) + "\n")
        print(json.dumps({"id": artifact["id"], "validation": artifact["validationScores"], "heldOut": held_out}), flush=True)
    finally:
        engine.close()


if __name__ == "__main__":
    main()
