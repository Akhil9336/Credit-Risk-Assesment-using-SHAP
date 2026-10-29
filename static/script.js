/* ==========================================================================
   CreditLens — front-end logic for the Credit Risk Prediction API
   ========================================================================== */
(() => {
  "use strict";

  /* ------------------------------------------------------------------------
     Config
     Leave API_BASE empty when FastAPI serves this page itself (same origin).
     If the UI is hosted somewhere else, set it to your Render URL, e.g.
       const API_BASE = "https://your-service.onrender.com";
     and enable CORS on the API.
  ------------------------------------------------------------------------ */
  const LOCAL_API = "http://127.0.0.1:8000";   // uvicorn's default address
  const isLocalDevPage =
    location.protocol === "file:" ||
    ((location.hostname === "127.0.0.1" || location.hostname === "localhost") && location.port !== "8000");
  // On Live Server / file:// use the local API; when FastAPI serves the page, use same origin.
  const API_BASE = isLocalDevPage ? LOCAL_API : "";
  const PREDICT_URL = `${API_BASE}/predict`;
  const HEALTH_URL = `${API_BASE}/health`;
  const REQUEST_TIMEOUT_MS = 75000;   // Render free tier cold starts can be slow
  const SLOW_HINT_MS = 4000;

  /* ------------------------------------------------------------------------
     Helpers + element refs
  ------------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const form = $("#risk-form");
  const submitBtn = $("#submit-btn");
  const resultCard = $("#result-card");
  const gaugeFill = $("#gauge-fill");
  const gaugeTick = $("#gauge-tick");
  const pctValue = $("#pct-value");
  const badgeText = $("#verdict-badge-text");
  const verdictLine = $("#verdict-line");
  const statThreshold = $("#stat-threshold");
  const statMargin = $("#stat-margin");
  const statLti = $("#stat-lti");
  const rawJson = $("#raw-json");
  const rateInput = form.elements.loan_int_rate;
  const rateRange = $("#loan_int_rate_range");
  const statusEl = $("#api-status");
  const statusText = $("#api-status-text");

  const fieldEl = (name) => form.querySelector(`[data-field="${name}"]`);

  /* ------------------------------------------------------------------------
     Example presets
  ------------------------------------------------------------------------ */
  const PRESETS = {
    stable: {
      person_age: 35, person_income: 85000, person_home_ownership: "MORTGAGE",
      person_emp_length: 10, loan_intent: "HOMEIMPROVEMENT", loan_grade: "A",
      loan_amnt: 8000, loan_int_rate: 7.5,
      cb_person_default_on_file: "N", cb_person_cred_hist_length: 12,
    },
    average: {
      person_age: 28, person_income: 45000, person_home_ownership: "RENT",
      person_emp_length: 3, loan_intent: "EDUCATION", loan_grade: "C",
      loan_amnt: 10000, loan_int_rate: 12.8,
      cb_person_default_on_file: "N", cb_person_cred_hist_length: 5,
    },
    stretched: {
      person_age: 22, person_income: 18000, person_home_ownership: "RENT",
      person_emp_length: 0, loan_intent: "PERSONAL", loan_grade: "G",
      loan_amnt: 15000, loan_int_rate: 21.5,
      cb_person_default_on_file: "Y", cb_person_cred_hist_length: 2,
    },
  };

  /* ------------------------------------------------------------------------
     Derived fields (loan-to-income ratio, rate slider)
  ------------------------------------------------------------------------ */
  function syncRatio() {
    const amount = form.elements.loan_amnt.valueAsNumber;
    const income = form.elements.person_income.valueAsNumber;
    const out = form.elements.loan_percent_income;
    out.value = amount > 0 && income > 0
      ? (Math.round((amount / income) * 100) / 100).toFixed(2)
      : "";
  }

  function syncSliderFromInput() {
    const v = rateInput.valueAsNumber;
    if (Number.isFinite(v)) rateRange.value = Math.min(Math.max(v, 5), 25);
  }

  rateRange.addEventListener("input", () => {
    rateInput.value = Number(rateRange.value).toFixed(2);
    clearFieldError("loan_int_rate");
  });

  rateInput.addEventListener("input", syncSliderFromInput);

  ["loan_amnt", "person_income"].forEach((name) => {
    form.elements[name].addEventListener("input", syncRatio);
  });

  /* ------------------------------------------------------------------------
     Collect + validate (mirrors the Pydantic rules in the API)
  ------------------------------------------------------------------------ */
  function collect() {
    const num = (name) => form.elements[name].valueAsNumber;
    const str = (name) => form.elements[name].value;
    return {
      person_age: num("person_age"),
      person_income: num("person_income"),
      person_home_ownership: str("person_home_ownership"),
      person_emp_length: num("person_emp_length"),
      loan_intent: str("loan_intent"),
      loan_grade: str("loan_grade"),
      loan_amnt: num("loan_amnt"),
      loan_int_rate: num("loan_int_rate"),
      loan_percent_income: parseFloat(form.elements.loan_percent_income.value),
      cb_person_default_on_file: str("cb_person_default_on_file"),
      cb_person_cred_hist_length: num("cb_person_cred_hist_length"),
    };
  }

  function validate(p) {
    const e = {};

    if (!Number.isInteger(p.person_age) || p.person_age < 18 || p.person_age > 100)
      e.person_age = "Enter a whole number between 18 and 100.";

    if (!(p.person_income > 0))
      e.person_income = "Income must be greater than 0.";

    if (!p.person_home_ownership)
      e.person_home_ownership = "Select an option.";

    if (!(p.person_emp_length >= 0))
      e.person_emp_length = "Enter 0 or more years.";
    else if (Number.isFinite(p.person_age) && p.person_emp_length >= p.person_age)
      e.person_emp_length = "Must be less than the applicant's age.";

    if (!p.loan_intent)
      e.loan_intent = "Select a purpose.";

    if (!p.loan_grade)
      e.loan_grade = "Pick a loan grade.";

    if (!(p.loan_amnt > 0))
      e.loan_amnt = "Loan amount must be greater than 0.";

    if (!(p.loan_int_rate >= 0))
      e.loan_int_rate = "Enter an interest rate of 0 or more.";

    if (!(p.cb_person_cred_hist_length >= 0) || !Number.isInteger(p.cb_person_cred_hist_length))
      e.cb_person_cred_hist_length = "Enter a whole number, 0 or more.";
    else if (Number.isFinite(p.person_age) && p.cb_person_cred_hist_length >= p.person_age)
      e.cb_person_cred_hist_length = "Must be less than the applicant's age.";

    if (!Number.isFinite(p.loan_percent_income) && !e.loan_amnt && !e.person_income)
      e.loan_amnt = "Could not compute loan-to-income.";

    return e;
  }

  function showErrors(errors) {
    let first = null;
    Object.entries(errors).forEach(([name, message]) => {
      const field = fieldEl(name);
      if (!field) return;
      field.classList.remove("invalid");
      void field.offsetWidth; // restart the shake animation
      field.classList.add("invalid");
      field.querySelector(".msg").textContent = message;
      first = first || field;
    });

    if (first) {
      const target = first.querySelector("input, select");
      if (target) target.focus({ preventScroll: true });
      first.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    }
  }

  function clearFieldError(name) {
    const field = fieldEl(name);
    if (!field) return;
    field.classList.remove("invalid");
    field.querySelector(".msg").textContent = "";
  }

  function clearErrors() {
    $$(".field.invalid").forEach((f) => {
      f.classList.remove("invalid");
      f.querySelector(".msg").textContent = "";
    });
  }

  form.addEventListener("input", (ev) => {
    const field = ev.target.closest(".field");
    if (field && field.classList.contains("invalid")) clearFieldError(field.dataset.field);
  });

  /* ------------------------------------------------------------------------
     Result card: state, gauge, count-up
  ------------------------------------------------------------------------ */
  let raf = 0;
  let currentPct = 0;

  function setState(state, tone) {
    resultCard.dataset.state = state;
    if (tone) resultCard.dataset.tone = tone;
    else delete resultCard.dataset.tone;
  }

  function paintGauge(value) {
    currentPct = value;
    gaugeFill.style.strokeDasharray = `${value} 100`;
    gaugeFill.style.opacity = value < 0.4 ? "0" : "1";
    pctValue.textContent = value.toFixed(1);
  }

  function animateGaugeTo(target) {
    cancelAnimationFrame(raf);
    const from = currentPct;
    const duration = reduceMotion ? 0 : 1400;
    const start = performance.now();

    const step = (now) => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      const eased = 1 - Math.pow(1 - t, 4);
      paintGauge(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
  }

  function placeThresholdTick(threshold) {
    const t = Math.min(Math.max(threshold, 0), 1);
    const angle = Math.PI * t;
    const cx = 110, cy = 110, inner = 79, outer = 101;
    gaugeTick.setAttribute("x1", (cx - inner * Math.cos(angle)).toFixed(2));
    gaugeTick.setAttribute("y1", (cy - inner * Math.sin(angle)).toFixed(2));
    gaugeTick.setAttribute("x2", (cx - outer * Math.cos(angle)).toFixed(2));
    gaugeTick.setAttribute("y2", (cy - outer * Math.sin(angle)).toFixed(2));
  }

  function resetResult() {
    cancelAnimationFrame(raf);
    currentPct = 0;
    gaugeFill.style.strokeDasharray = "0 100";
    gaugeFill.style.opacity = "0";
    pctValue.textContent = "—";
    statThreshold.textContent = "—";
    statMargin.textContent = "—";
    statLti.textContent = "—";
    rawJson.textContent = "";
    badgeText.textContent = "Awaiting input";
    verdictLine.textContent = "Fill in the application and run an assessment.";
    setState("idle");
  }

  function renderResult(data, payload) {
    const prob = Number(data.default_probability);
    const threshold = Number(data.threshold);

    if (!Number.isFinite(prob) || !Number.isFinite(threshold)) {
      throw new Error("The API returned an unexpected response.");
    }

    const flagged = Number(data.default_prediction) === 1;
    const margin = (prob - threshold) * 100;
    const sign = margin < 0 ? "−" : "+";

    setState("result", flagged ? "danger" : "safe");
    badgeText.textContent = flagged ? "High risk" : "Low risk";
    verdictLine.textContent = flagged
      ? "Above the decision threshold. This application is flagged as likely to default."
      : "Below the decision threshold. This application is not flagged as likely to default.";

    statThreshold.textContent = `${(threshold * 100).toFixed(1)}%`;
    statMargin.textContent = `${sign}${Math.abs(margin).toFixed(1)} pts`;
    statLti.textContent = `${Math.round(payload.loan_percent_income * 100)}%`;
    rawJson.textContent = JSON.stringify(data, null, 2);

    placeThresholdTick(threshold);
    animateGaugeTo(prob * 100);
  }

  class ApiError extends Error {
    constructor(status, detail) {
      super(`HTTP ${status}`);
      this.status = status;
      this.detail = detail;
    }
  }

  function renderError(err) {
    let message = "Something went wrong. Please try again.";

    if (err.name === "AbortError") {
      message = "The request timed out. The server may still be starting up, so try again in a moment.";
    } else if (err instanceof ApiError) {
      if (err.status === 422 && Array.isArray(err.detail)) {
        const mapped = {};
        err.detail.forEach((d) => {
          const name = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : null;
          if (name && fieldEl(name)) mapped[name] = d.msg || "Invalid value.";
        });
        showErrors(mapped);
        message = "The API rejected some inputs. Check the highlighted fields.";
      } else if (err.status === 404) {
        message = "Prediction endpoint not found (404). Check that the API is deployed and the URL is correct.";
      } else if (err.status >= 500) {
        message = `The model service hit an error (HTTP ${err.status}). Check the server logs on Render.`;
      } else {
        message = `The API responded with HTTP ${err.status}.`;
      }
    } else if (err instanceof TypeError) {
      message = "Couldn't reach the API. Check your connection, or whether the service is still waking up.";
      setStatus("offline", "API unreachable");
    } else if (err.message) {
      message = err.message;
    }

    setState("error", "danger");
    badgeText.textContent = "Error";
    verdictLine.textContent = message;
  }

  /* ------------------------------------------------------------------------
     Submit
  ------------------------------------------------------------------------ */
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearErrors();

    const payload = collect();
    const errors = validate(payload);
    if (Object.keys(errors).length) {
      showErrors(errors);
      return;
    }

    await assess(payload);
  });

  async function assess(payload) {
    submitBtn.classList.add("busy");
    submitBtn.disabled = true;
    setState("loading");
    badgeText.textContent = "Scoring…";
    verdictLine.textContent = "Scoring the application…";

    if (window.matchMedia("(max-width: 960px)").matches) {
      resultCard.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }

    const slowTimer = setTimeout(() => {
      verdictLine.textContent = "Still working. A sleeping server can take up to a minute to wake up.";
    }, SLOW_HINT_MS);

    const controller = new AbortController();
    const killTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(PREDICT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let body = null;
      try { body = await res.json(); } catch (_) { /* non-JSON body */ }

      if (!res.ok) throw new ApiError(res.status, body && body.detail);

      renderResult(body, payload);
      setStatus("online", "API online");
    } catch (err) {
      renderError(err);
    } finally {
      clearTimeout(slowTimer);
      clearTimeout(killTimer);
      submitBtn.classList.remove("busy");
      submitBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------------
     Presets + reset
  ------------------------------------------------------------------------ */
  function applyPreset(key) {
    const preset = PRESETS[key];
    if (!preset) return;

    clearErrors();

    Object.entries(preset).forEach(([name, value]) => {
      form.elements[name].value = value;
      const field = fieldEl(name);
      if (field) {
        field.classList.remove("flash");
        void field.offsetWidth;
        field.classList.add("flash");
      }
    });

    syncRatio();
    syncSliderFromInput();
  }

  $$("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });

  form.addEventListener("reset", () => {
    clearErrors();
    // Wait for the browser to restore default values, then refresh derived UI.
    setTimeout(() => {
      syncRatio();
      rateRange.value = 12;
      resetResult();
    }, 0);
  });

  /* ------------------------------------------------------------------------
     API status pill (retries so a cold-starting Render service can wake up)
  ------------------------------------------------------------------------ */
  let pingToken = 0;

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusText.textContent = text;
  }

  async function pingApi(attempt = 0) {
    const token = ++pingToken;
    setStatus("checking", attempt ? "Waking server…" : "Connecting…");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      // Any HTTP response below 500 means the server is up.
      const res = await fetch(HEALTH_URL, { signal: controller.signal, cache: "no-store" });
      if (token !== pingToken) return;
      if (res.status >= 400) throw new Error("API not reachable at this address");
      setStatus("online", "API online");
    } catch (_) {
      if (token !== pingToken) return;
      if (attempt < 5) {
        setStatus("checking", "Waking server…");
        setTimeout(() => { if (token === pingToken) pingApi(attempt + 1); }, 4000);
      } else {
        setStatus("offline", "API unreachable. Click to retry");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  statusEl.addEventListener("click", () => pingApi());

  /* ------------------------------------------------------------------------
     Card spotlight following the cursor
  ------------------------------------------------------------------------ */
  $$(".card").forEach((card) => {
    card.addEventListener("pointermove", (ev) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${ev.clientX - r.left}px`);
      card.style.setProperty("--my", `${ev.clientY - r.top}px`);
    });
  });

  /* ------------------------------------------------------------------------
     Init
  ------------------------------------------------------------------------ */
  syncRatio();
  syncSliderFromInput();
  resetResult();
  pingApi();
})();