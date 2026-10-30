const $ = (id) => document.getElementById(id);
const signals = [
  "Khruangbin",
  "Spirited Away",
  "Beyoncé",
  "The Grand Budapest Hotel",
  "Miles Davis",
  "Dune",
];
let people = [
    ["Khruangbin", "Miles Davis"],
    ["Spirited Away", "The Grand Budapest Hotel"],
  ],
  veto = [],
  last = null,
  previous = null,
  generation = 0,
  currentRequest = null;
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function renderPeople() {
  $("people").replaceChildren();
  people.forEach((selected, i) => {
    const wrap = el("div", undefined, "person"),
      field = el("fieldset");
    field.append(el("legend", `Person ${i + 1}`));
    const chips = el("div", undefined, "chips");
    signals.forEach((s) => {
      const label = el("label", undefined, "chip"),
        check = document.createElement("input");
      check.type = "checkbox";
      check.checked = selected.includes(s);
      check.addEventListener("change", () => {
        if (check.checked && people[i].length >= 3) {
          check.checked = false;
          $("status").textContent =
            "Choose at most three interests for each person.";
          return;
        }
        people[i] = check.checked
          ? [...people[i], s]
          : people[i].filter((x) => x !== s);
        dirty();
      });
      label.append(check, document.createTextNode(s));
      chips.append(label);
    });
    field.append(chips);
    wrap.append(field);
    if (i >= 2) {
      const b = el("button", "Remove person", "removed");
      b.type = "button";
      b.onclick = () => {
        people.splice(i, 1);
        renderPeople();
        dirty();
      };
      wrap.append(b);
    }
    $("people").append(wrap);
  });
  $("add").disabled = people.length >= 4;
}
function dirty() {
  generation++;
  currentRequest?.abort();
  $("status").className = "";
  $("submit").disabled = false;
  $("submit").textContent = "Find our common ground";
  $("status").textContent =
    "Preferences changed. Run again to update the comparison.";
  $("resultJump").hidden = true;
  $("results").replaceChildren();
  $("comparison").replaceChildren();
  $("trace").replaceChildren();
}
function read() {
  return {
    mode: $("mode").value,
    people: people.map((signals) => ({ signals: [...signals] })),
    budget: $("budget").value ? Number($("budget").value) : null,
    floor: Number($("floor").value),
    fairness: Number($("fairness").value),
    scenario: $("scenario").value,
    veto: [...veto],
  };
}
const indexText = (value) => Number(value.toFixed(1));
function evidenceDetails(c, data) {
  const details = el("details", undefined, "evidence-detail");
  details.id = "winner-evidence";
  details.append(el("summary", "Interests & source evidence"));
  data.input.people.forEach((p, i) =>
    details.append(
      el("p", `Person ${i + 1}: ${p.signals.join(" + ")}`, "small"),
    ),
  );
  if (data.mode === "live") {
    if (c.address)
      details.append(
        el(
          "p",
          `Provider address: ${typeof c.address === "string" ? c.address : JSON.stringify(c.address)}`,
          "small",
        ),
      );
    if (c.geocode)
      details.append(
        el("p", `Provider geocode: ${JSON.stringify(c.geocode)}`, "small"),
      );
    if (c.priceLevel !== null && c.priceLevel !== undefined)
      details.append(
        el(
          "p",
          `Provider price category: ${JSON.stringify(c.priceLevel)}; dollar cost is unverified.`,
          "small",
        ),
      );
    details.append(
      el(
        "p",
        JSON.stringify({
          discovery: c.discoveryEvidence,
          participantRanks: c.participantEvidence,
        }),
        "small",
      ),
    );
  } else
    details.append(
      el(
        "p",
        data.fixtureScenario ??
          "Synthetic cultural scores, converted to relative shortlist ranks. No Qloo calls.",
        "small",
      ),
    );
  return details;
}
function vetoButton(c) {
  const button = el("button", "Veto & replan", "veto");
  button.type = "button";
  button.setAttribute("aria-label", `Veto & replan: ${c.name}`);
  button.onclick = () => {
    veto.push(c.id);
    run(read());
  };
  return button;
}
function show(data) {
  $("results").replaceChildren();
  $("comparison").replaceChildren();
  $("trace").replaceChildren();
  $("status").className = "";
  $("status").textContent =
    `${data.mode === "fixture" ? "SIMULATED" : "LIVE QLOO"} · ${data.candidates.length} candidates clear every constraint.`;
  $("resultJump").hidden = false;
  const winner = data.candidates[0],
    baseline = data.baseline;
  if (data.fixtureScenario)
    $("comparison").append(
      el(
        "p",
        "CONSTRUCTED FIXTURE REHEARSAL — authored to expose a ranking trade-off. Not provider output.",
        "scenario-disclosure",
      ),
    );
  if (winner) {
    const decision = el("section", undefined, "decision-summary");
    decision.setAttribute("aria-label", "Why this compromise");
    decision.append(el("div", "DECISION", "eyebrow"));
    const decisionHeading = el("h2", "Why this compromise");
    decisionHeading.id = "decisionTitle";
    decisionHeading.tabIndex = -1;
    decision.append(decisionHeading);
    let why = `Choose ${winner.name}: it leads your weighted rule with ${indexText(winner.score)} consensus points.`;
    if (baseline && baseline.id !== winner.id)
      why += ` Compared with average-only ${baseline.name}, lowest rank points change from ${indexText(baseline.minimum)} to ${indexText(winner.minimum)}, while mean changes from ${indexText(baseline.mean)} to ${indexText(winner.mean)}.`;
    else if (baseline)
      why += " Average-only selects the same place for this input.";
    decision.append(el("p", why));
    const source = el(
      "a",
      data.mode === "fixture"
        ? "Inspect authored fixture evidence"
        : "Inspect returned Qloo evidence",
      "source-link",
    );
    source.href =
      data.mode === "fixture" ? "/fixtures.json" : "#winner-evidence";
    if (data.mode === "fixture") {
      source.target = "_blank";
      source.rel = "noopener";
    } else
      source.onclick = () => {
        $("winner-evidence").open = true;
      };
    decision.append(source);
    $("comparison").append(decision);
  }
  if (baseline && winner) {
    const compare = el("div", undefined, "strategy-comparison");
    compare.setAttribute("aria-label", "Strategy comparison");
    for (const [label, c] of [
      ["AVERAGE ONLY", baseline],
      ["YOUR WEIGHTED CHOICE", winner],
    ]) {
      const item = el("div", undefined, "strategy-item");
      item.append(
        el("div", label, "eyebrow"),
        el("strong", c.name),
        el(
          "p",
          `Lowest ${indexText(c.minimum)} · Mean ${indexText(c.mean)}`,
          "small",
        ),
      );
      compare.append(item);
    }
    $("comparison").append(compare);
    $("comparison").append(
      el(
        "p",
        "Average-only uses the same veto, evidence and fixture-cost checks, before the optional rank cutoff. Points are relative ranks, not measured satisfaction.",
        "comparison-note",
      ),
    );
  }
  if (baseline?.reasons?.length)
    $("comparison").append(
      el(
        "p",
        `Average-only leader excluded from consensus by: ${baseline.reasons.join("; ")}.`,
        "small",
      ),
    );
  if (previous && previous.mode === data.mode) {
    const old = previous.candidates[0];
    $("comparison").append(
      el(
        "p",
        `${old?.name ?? "No match"} to ${winner?.name ?? "No match"}. ${old?.id === winner?.id ? "Top choice holds after revision." : "The leading compromise changed."}`,
        "changed",
      ),
    );
  }
  if (!winner)
    $("results").append(
      el("h3", "No one-size-fits-all answer."),
      el(
        "p",
        "Nothing clears every constraint. Lower the optional rank cutoff, revise the fixture cap, or reset vetoes. The agent kept your constraints intact.",
      ),
    );
  if (winner) {
    const card = el("article", undefined, "card winner");
    card.append(
      el("div", "SELECTED SHARED COMPROMISE", "card-tag"),
      el("h3", winner.name),
      el("div", winner.kind, "card-tag"),
      el("p", winner.description),
    );
    winner.fit.forEach((fit, p) => {
      const row = el("div", undefined, "fit"),
        track = el("div", undefined, "track"),
        bar = el(
          "div",
          undefined,
          `bar ${fit === winner.minimum ? "orange" : ""}`,
        );
      bar.style.width = `${fit}%`;
      track.setAttribute("aria-hidden", "true");
      track.append(bar);
      row.append(
        el("span", `Person ${p + 1}`),
        track,
        el("strong", String(indexText(fit))),
      );
      card.append(row);
    });
    card.append(
      el(
        "p",
        `Lowest rank points ${indexText(winner.minimum)} · Mean ${indexText(winner.mean)} · Consensus points ${indexText(winner.score)}`,
        "trade",
      ),
      evidenceDetails(winner, data),
    );
    const foot = el("div", undefined, "card-foot");
    foot.append(
      el(
        "span",
        winner.cost === null
          ? "Cost unverified"
          : `$${winner.cost} / illustrative only`,
      ),
      vetoButton(winner),
    );
    card.append(foot);
    $("results").append(card);
    if (data.candidates.length > 1) {
      const alternatives = el("details", undefined, "alternatives");
      alternatives.id = "alternatives";
      alternatives.append(
        el("summary", `Compare ${data.candidates.length - 1} alternatives`),
      );
      data.candidates.slice(1).forEach((c) => {
        const item = el("article", undefined, "alternative-row");
        item.append(
          el("h3", c.name),
          el(
            "p",
            `Ranks ${c.fit.map(indexText).join(" / ")} · Lowest ${indexText(c.minimum)} · Mean ${indexText(c.mean)}`,
            "small",
          ),
          vetoButton(c),
        );
        alternatives.append(item);
      });
      $("results").append(alternatives);
    }
  }
  const steps = el("ol", undefined, "decision-steps");
  steps.setAttribute("aria-label", "Completed agent steps");
  for (const [i, t] of data.trace.entries()) {
    const li = el("li");
    li.append(el("span", String(i + 1)), el("strong", t.step));
    steps.append(li);
  }
  $("results").append(steps);
  data.trace.forEach((t) =>
    $("trace").append(el("p", `${t.step}: ${t.detail}`)),
  );
  $("trace").append(
    el("p", data.provenance),
    el(
      "p",
      `Formula: ${data.formula}. Points describe relative ranks, not affinity magnitude.`,
    ),
  );
  data.rejected.forEach((c) =>
    $("trace").append(el("p", `${c.name}: ${c.reasons.join("; ")}`)),
  );
  data.limits.forEach((l) => $("trace").append(el("p", l)));
}

async function run(input) {
  const id = ++generation;
  currentRequest?.abort();
  const requestController = new AbortController();
  currentRequest = requestController;
  $("submit").disabled = true;
  $("submit").textContent = "Comparing everyone’s tastes…";
  $("status").className = "";
  $("status").textContent = "Plan → discover → rank → revise";
  $("resultJump").hidden = true;
  $("results").replaceChildren();
  $("comparison").replaceChildren();
  $("trace").replaceChildren();
  try {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: requestController.signal,
    });
    const data = await response.json();
    if (id !== generation) return;
    if (!response.ok) throw new Error(data.error);
    previous = last?.data ?? null;
    last = { input: structuredClone(input), data };
    show(data);
  } catch (e) {
    if (id !== generation) return;
    $("status").className = "error";
    $("status").textContent = e.message + " You can retry or reset.";
  } finally {
    if (id === generation) {
      $("submit").disabled = false;
      $("submit").textContent = "Find our common ground";
    }
  }
}
$("form").onsubmit = (e) => {
  e.preventDefault();
  run(read());
};
$("add").onclick = () => {
  people.push(["Dune"]);
  renderPeople();
  dirty();
};
["floor", "fairness"].forEach(
  (k) =>
    ($(k).oninput = () => {
      $(k + "Value").value = $(k).value;
      dirty();
    }),
);
["budget", "scenario"].forEach((k) => ($(k).onchange = dirty));
$("mode").onchange = () => {
  veto = [];
  const live = $("mode").value === "live";
  $("scenario").value = "normal";
  $("scenario").disabled = live;
  $("tradeoff").disabled = live;
  $("budget").disabled = live;
  if (live) $("budget").value = "";
  $("modeBadge").textContent = live
    ? "LIVE QLOO SELECTED"
    : "FIXTURE SIMULATION";
  $("noticeTitle").textContent = live
    ? "Live mode selected."
    : "A transparent rehearsal.";
  $("noticeText").textContent = live
    ? "Requires owner-approved live enablement and a server-side event key. No fixture fallback. Address and taste evidence come from Qloo; costs, hours and availability are unverified. Price filtering is unavailable."
    : "All places and affinity values are fictional fixtures. No live Qloo calls, actual prices or availability.";
  dirty();
};
$("reset").onclick = () => {
  people = [
    ["Khruangbin", "Miles Davis"],
    ["Spirited Away", "The Grand Budapest Hotel"],
  ];
  veto = [];
  last = null;
  previous = null;
  HTMLFormElement.prototype.reset.call($("form"));
  $("floorValue").value = 0;
  $("fairnessValue").value = 80;
  $("mode").onchange();
  renderPeople();
  $("status").textContent =
    "Reset complete. All in-memory preferences and results cleared.";
};
$("replay").onclick = () => {
  if (!last) {
    $("status").textContent = "Run a plan first.";
    return;
  }
  const i = structuredClone(last.input);
  people = i.people.map((p) => p.signals);
  veto = i.veto;
  $("mode").value = i.mode;
  $("mode").onchange();
  veto = i.veto;
  ["floor", "fairness", "scenario"].forEach((k) => ($(k).value = i[k]));
  $("budget").value = i.budget ?? "";
  ["floor", "fairness"].forEach((k) => ($(k + "Value").value = i[k]));
  renderPeople();
  run(i);
};
$("export").onclick = () => {
  if (!last) {
    $("status").textContent = "Run a plan first.";
    return;
  }
  const blob = new Blob([JSON.stringify(last, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    a = el("a");
  a.href = url;
  a.download = "common-ground-run.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
renderPeople();

$("tradeoff").onclick = () => {
  if ($("mode").value !== "fixture") return;
  people = [["Khruangbin"], ["Spirited Away"]];
  veto = [];
  $("budget").value = "";
  $("floor").value = "0";
  $("fairness").value = "80";
  $("floorValue").value = 0;
  $("fairnessValue").value = 80;
  $("scenario").value = "tradeoff";
  renderPeople();
  run(read());
};
$("jump").onclick = (e) => {
  e.preventDefault();
  const target = $("decisionTitle") ?? $("resultsTitle");
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "start", behavior: "auto" });
};
