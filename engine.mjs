import fixtureData from "./public/fixtures.json" with { type: "json" };
export const { signals, places } = fixtureData;
export class Problem extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function validate(input) {
  if (
    !input ||
    !Array.isArray(input.people) ||
    input.people.length < 2 ||
    input.people.length > 4
  )
    throw new Problem("INPUT", "Choose two to four participants.");
  const people = input.people.map((p, i) => {
    if (
      !p ||
      !Array.isArray(p.signals) ||
      !p.signals.length ||
      p.signals.length > 3 ||
      p.signals.some((s) => !signals.includes(s))
    )
      throw new Problem(
        "INPUT",
        "Select one to three cultural signals per person.",
      );
    return { label: `Person ${i + 1}`, signals: [...new Set(p.signals)] };
  });
  const budget = input.budget ?? null;
  if (budget !== null && ![20, 30, 60].includes(budget))
    throw new Problem("INPUT", "Unsupported budget.");
  const floor = input.floor ?? 0;
  if (!Number.isInteger(floor) || floor < 0 || floor > 100)
    throw new Problem("INPUT", "Relative rank cutoff must be 0–100.");
  const fairness = input.fairness ?? 80;
  if (!Number.isInteger(fairness) || fairness < 0 || fairness > 100)
    throw new Problem("INPUT", "Fairness must be 0–100.");
  if (
    input.veto !== undefined &&
    (!Array.isArray(input.veto) ||
      input.veto.length > 40 ||
      input.veto.some((x) => typeof x !== "string" || x.length > 80))
  )
    throw new Problem("INPUT", "Invalid veto list.");
  if (
    input.scenario &&
    !["normal", "tradeoff", "empty", "timeout", "duplicates"].includes(
      input.scenario,
    )
  )
    throw new Problem("INPUT", "Invalid simulation.");
  return {
    people,
    budget,
    floor,
    fairness,
    veto: input.veto ?? [],
    scenario: input.scenario ?? "normal",
  };
}
export class FixtureAdapter {
  mode = "fixture";
  async discover(person, input) {
    if (input.scenario === "timeout")
      throw new Problem(
        "UPSTREAM_TIMEOUT",
        "Simulated Qloo timeout. Retry or reset the simulation.",
        503,
      );
    if (input.scenario === "empty") return [];
    return [
      ...places,
      ...(input.scenario === "duplicates" ? [places[0]] : []),
    ].map(({ scores, ...p }) => p);
  }
  async rank(person, candidates, { input } = {}) {
    const ordered = candidates
      .map((c) => ({
        id: c.id,
        affinity:
          person.signals.reduce(
            (sum, signal) =>
              sum +
              (input?.scenario === "tradeoff"
                ? fixtureData.tradeoff.scores[c.id]
                : places.find((p) => p.id === c.id).scores)[
                signals.indexOf(signal)
              ],
            0,
          ) / person.signals.length,
      }))
      .sort((a, b) => b.affinity - a.affinity || a.id.localeCompare(b.id));
    return relativeRankPoints(ordered);
  }
}
// Returned order is authoritative; equal explicit finite affinities share average rank.
export function relativeRankPoints(rows) {
  return rows.map((x, i, a) => {
    const ties =
      typeof x.affinity === "number" && Number.isFinite(x.affinity)
        ? a
            .map((v, j) => (v.affinity === x.affinity ? j : -1))
            .filter((j) => j >= 0)
        : [i];
    const rank = ties.reduce((sum, j) => sum + j, 0) / ties.length;
    return {
      id: x.id,
      fit: a.length === 1 ? 50 : (100 * (a.length - 1 - rank)) / (a.length - 1),
      providerAffinity: x.affinity ?? null,
      explanation: x.explanation ?? null,
    };
  });
}

async function completePhase(operations, signal) {
  const outcomes = await Promise.allSettled(
    operations.map((operation) =>
      Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return operation();
      }),
    ),
  );
  signal?.throwIfAborted();
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  return outcomes.map((outcome) => outcome.value);
}
export async function plan(
  raw,
  adapter = new FixtureAdapter(),
  { signal } = {},
) {
  signal?.throwIfAborted();
  const input = validate(raw);
  if (adapter.mode === "live" && input.budget !== null)
    throw new Problem(
      "PRICE_UNVERIFIED",
      "Live costs are unverified. Use no spend cap, or use the fixture rehearsal; no live price filtering was performed.",
    );
  const trace = [
    {
      step: "Plan",
      detail: `${input.people.length} participants; ${input.budget === null ? "no spend cap" : `$${input.budget} cap`}; relative rank cutoff ${input.floor}.`,
    },
  ];
  const groups = await completePhase(
    input.people.map((p) => () => adapter.discover(p, input, { signal })),
    signal,
  );
  const roundRobin = [];
  for (let i = 0; i < Math.max(0, ...groups.map((g) => g.length)); i++)
    for (const group of groups) if (group[i]) roundRobin.push(group[i]);
  const merged = new Map();
  for (const c of roundRobin) {
    const old = merged.get(c.id);
    merged.set(
      c.id,
      old
        ? {
            ...old,
            discoveryEvidence: [
              ...(old.discoveryEvidence ?? []),
              ...(c.discoveryEvidence ?? []),
            ],
          }
        : c,
    );
  }
  const candidates = [...merged.values()].slice(0, 10);
  trace.push({
    step: "Discover",
    detail: `${candidates.length} unique candidates across all participants.`,
  });
  const rankings = candidates.length
    ? await completePhase(
        input.people.map(
          (p) => () => adapter.rank(p, candidates, { signal, input }),
        ),
        signal,
      )
    : input.people.map(() => []);
  const evaluated = candidates.map((c) => {
    const fit = rankings.map((r) => r.find((x) => x.id === c.id)?.fit ?? null);
    const reasons = [];
    if (input.veto.includes(c.id)) reasons.push("Explicitly vetoed");
    if (input.budget !== null && (c.cost == null || c.cost > input.budget))
      reasons.push(
        c.cost == null ? "Cost unverified" : "Over illustrative budget",
      );
    if (fit.some((x) => x === null))
      reasons.push("Missing participant evidence");
    if (fit.some((x) => x !== null && x < input.floor))
      reasons.push("Below optional relative rank cutoff");
    const minimum = fit.some((x) => x === null) ? 0 : Math.min(...fit),
      mean = fit.reduce((a, b) => a + (b ?? 0), 0) / fit.length;
    return {
      ...c,
      fit,
      participantEvidence: rankings.map((r) => {
        const row = r.find((x) => x.id === c.id);
        return {
          providerAffinity: row?.providerAffinity ?? null,
          explanation: row?.explanation ?? null,
        };
      }),
      minimum,
      mean,
      score:
        (minimum * input.fairness) / 100 + mean * (1 - input.fairness / 100),
      reasons,
    };
  });
  const eligible = evaluated
    .filter((x) => !x.reasons.length)
    .sort(
      (a, b) =>
        b.score - a.score || b.minimum - a.minimum || a.id.localeCompare(b.id),
    );
  trace.push(
    {
      step: "Rank",
      detail: `Scored ${candidates.length} candidates against each person separately. ${evaluated.length - eligible.length} excluded.`,
    },
    {
      step: "Revise",
      detail: eligible.length
        ? "Review the trade-offs, veto a place or change preferences and run again."
        : "No compromise clears every constraint. Revise the optional rank cutoff, cap or vetoes; constraints were not relaxed.",
    },
  );
  const baseline =
    [
      ...evaluated.filter((c) =>
        c.reasons.every(
          (reason) => reason === "Below optional relative rank cutoff",
        ),
      ),
    ].sort((a, b) => b.mean - a.mean || a.id.localeCompare(b.id))[0] ?? null;
  return {
    mode: adapter.mode,
    fixtureScenario:
      adapter.mode === "fixture" && input.scenario === "tradeoff"
        ? fixtureData.tradeoff.description
        : null,
    input,
    trace,
    baseline,
    candidates: eligible,
    rejected: evaluated.filter((x) => x.reasons.length),
    provenance:
      adapter.mode === "fixture"
        ? "Authored fictional places and synthetic evidence converted to relative rank points; no live Qloo calls."
        : "Qloo exec workflow slice recommend + rank; rank points describe relative shortlist position, not absolute affinity or probability.",
    formula:
      "weight = fairness / 100; score = weight × lowest relative rank points + (1 − weight) × mean relative rank points",
    limits: [
      "Rank points describe relative position within this shortlist, never absolute affinity or enjoyment.",
      "No opening hours, accessibility, availability or bookings verified.",
      "No personal names or accounts are collected.",
    ],
  };
}
