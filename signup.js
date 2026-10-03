/*!
 * WentAround — signup form handler (two-state contract).
 *
 * LOCAL ENGINEERING PAGES STAY FULLY INERT:
 * signup-config.js is a comment-only stub, so window.__SHADOW_SIGNUP_CONFIG__
 * is undefined here. This script then binds NOTHING — no listeners, no
 * requests, no storage writes, no success state. The page behaves as if
 * this file did not exist.
 *
 * LIVE-SIGNUP VARIANTS ONLY (shadow-launches--deployed/ + publish repo):
 * when a real signup-config.js defines the canonical config keys
 *   window.__SHADOW_SIGNUP_CONFIG__ = { backendUrl, siteKey, source,
 *                                       consentVersion, captchaRequired }
 * this handler binds to <form data-signup> and POSTs exactly the frozen
 * backend contract (docs/backend-architecture.md §12 payload, §7 schema —
 * SignupCreate with extra:"forbid"):
 *   email (OPTIONAL — top-level key omitted entirely when the field is
 *          empty; stored when present), source, source_url, session_id,
 *          consent_version, captcha_token (only when the config requires
 *          captcha), plus every raw form field as form_data.
 * No top-level `session` and no boolean `consent` field is ever sent —
 * those are not backend-schema fields and would 422 (extra-forbid). No
 * `analytics` object is sent either: this page carries no tracking config,
 * so it posts the plain §12 field set (legacy-client shape; source_url is
 * the page the visitor signed up on, origin + path only).
 * The backend's verdict renders in the form's [role="status"] element
 * (2026-10-01 hardening: silently no-ops if the form has no status region).
 *
 * Response mapping (2026-09-26 user direction — the frontend renders the
 * backend's verdict, it is not the validator):
 *   200            -> success text. Every accepted attempt is its own row
 *                     (§6 fact table, duplicates included): repeated
 *                     submissions re-POST and store additional rows.
 *   422 validation -> a specific "Please check the form" message that names
 *                     the fix (never the generic failure text). Handles the
 *                     per-field detail array AND a string detail (the
 *                     extra-forbid rejection shape) AND an unparsable body.
 *   429            -> rate-limit wording
 *   400            -> verification/captcha wording
 *   captcha/network failure -> its own retry wording
 *   anything else  -> generic failure text
 * The reCAPTCHA Enterprise loader is injected lazily and ONLY when the
 * config sets captchaRequired (first submit, never on page load). No
 * cookies, no page storage; the session id is held in memory for the page
 * view only (one id per page load, ≤64 chars — server schema limit).
 */
(function () {
  "use strict";

  /* Config gate — canonical keys per docs/backend-architecture.md §12:
     backendUrl, siteKey, source, consentVersion, captchaRequired. Re-read
     at every submit attempt, so a missing/invalid config can never act. */
  function readConfig() {
    var cfg = window.__SHADOW_SIGNUP_CONFIG__;
    if (!cfg || typeof cfg !== "object") {
      return null;
    }
    if (typeof cfg.backendUrl !== "string" || !cfg.backendUrl) {
      return null;
    }
    return cfg;
  }

  /* DORMANT GATE — no live config: bind nothing at all. */
  if (!readConfig()) {
    return;
  }

  /* Status text for the live variant (copy strings S10/S11 + hardening wording). */
  var MSG_SUCCESS = "You're on the list — we'll email you when we launch.";
  var MSG_GENERIC = "Something went wrong — please try again.";
  var MSG_CHECK_FORM_FALLBACK = "Please check the form — enter a valid email address.";
  var MSG_RATE_LIMIT = "Too many attempts from your network — please wait a few minutes and try again.";
  var MSG_VERIFICATION = "Verification didn't complete — please reload the page and try again.";
  var MSG_UNREACHABLE = "We couldn't reach the signup service — check your connection and try again.";

  function writeStatus(form, message, kind, withMarker) {
    var region = form.querySelector('[role="status"]');
    if (!region) {
      return; /* no status region in this form: stay silent, never throw */
    }
    region.classList.remove("is-success", "is-error");
    if (kind) {
      region.classList.add(kind);
    }
    while (region.firstChild) {
      region.removeChild(region.firstChild);
    }
    if (withMarker) {
      var marker = document.createElement("span");
      marker.setAttribute("aria-hidden", "true");
      marker.appendChild(document.createTextNode("! "));
      region.appendChild(marker);
    }
    region.appendChild(document.createTextNode(message));
  }

  function clearStatus(form) {
    var region = form.querySelector('[role="status"]');
    if (region) {
      region.textContent = "";
      region.classList.remove("is-success", "is-error");
    }
  }

  /* Collect every named form control into form_data — the server stores it
     as-received (§6/§12). File inputs and buttons are skipped; a single
     checkbox -> boolean; checkboxes sharing a name -> array of checked
     values; radios -> the checked value, omitted when none is checked;
     multi-select -> array of selected values; text-like values are
     trimmed. Unknown fields/structure land here as-received (§7). */
  function collectFormData(form) {
    var groups = {};
    var elements = form.elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var tag = el.tagName;
      var type = (el.type || "").toLowerCase();
      if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
        continue;
      }
      if (!el.name || el.disabled) {
        continue;
      }
      if (type === "file" || type === "submit" || type === "button" ||
          type === "reset" || type === "image") {
        continue;
      }
      if (!groups[el.name]) {
        groups[el.name] = [];
      }
      groups[el.name].push(el);
    }

    var data = {};
    for (var name in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, name)) {
        continue;
      }
      var els = groups[name];
      var first = els[0];
      var firstType = (first.type || "").toLowerCase();

      if (firstType === "radio") {
        for (var j = 0; j < els.length; j++) {
          if (els[j].checked) {
            data[name] = els[j].value;
            break;
          }
        }
      } else if (firstType === "checkbox") {
        if (els.length === 1) {
          data[name] = first.checked; /* boolean */
        } else {
          var checked = [];
          for (var k = 0; k < els.length; k++) {
            if (els[k].checked) {
              checked.push(els[k].value);
            }
          }
          data[name] = checked;
        }
      } else if (first.tagName === "SELECT" && first.multiple) {
        var selected = [];
        for (var m = 0; m < first.options.length; m++) {
          if (first.options[m].selected) {
            selected.push(first.options[m].value);
          }
        }
        data[name] = selected;
      } else {
        data[name] = first.value.trim();
      }
    }
    return data;
  }

  /* email is OPTIONAL (§7/§12): the top-level key is included only when a
     non-empty value exists. Prefer the first input[type=email]; else the
     first collected field whose name mentions "email" and holds a string
     value (booleans and arrays from checkboxes never become the email). */
  function extractEmail(form, formData) {
    var input = form.querySelector("input[type=\"email\"]");
    var value = input && typeof input.value === "string" ? input.value : "";
    if (!value) {
      for (var key in formData) {
        if (Object.prototype.hasOwnProperty.call(formData, key) &&
            /email/i.test(key) && typeof formData[key] === "string") {
          value = formData[key];
          break;
        }
      }
    }
    value = (value || "").trim();
    return value || null;
  }

  /* session_id — one per page load (server schema limit: 64 chars), held in
     memory only. Ephemeral page-view id; no persistence of any kind. */
  var sessionId = null;

  function ensureSessionId() {
    if (sessionId) {
      return sessionId;
    }
    var crypto = window.crypto;
    if (crypto && typeof crypto.randomUUID === "function") {
      sessionId = crypto.randomUUID();
    } else if (crypto && typeof crypto.getRandomValues === "function") {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      sessionId = Array.prototype.map.call(bytes, function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    } else {
      sessionId = "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
    }
    return sessionId;
  }

  /* source_url — the page the visitor signed up on, origin + path only
     (query string and fragment stripped client-side; §7 "page URL captured
     by the frontend", matching the consent microcopy's disclosure). */
  function pageUrl() {
    try {
      return window.location.origin + window.location.pathname;
    } catch (err) {
      return "";
    }
  }

  /* Turn the backend's 422 per-field detail into a specific, plain-language fix. */
  function describeValidationError(detail) {
    var fixes = [];
    var seen = {};

    function add(text) {
      if (text && !seen[text]) {
        seen[text] = true;
        fixes.push(text);
      }
    }

    function emailFix() {
      add("enter a valid email address");
    }

    if (Array.isArray(detail)) {
      for (var i = 0; i < detail.length; i++) {
        var item = detail[i] || {};
        var loc = Array.isArray(item.loc) ? item.loc.join(".") : "";
        var msg = typeof item.msg === "string"
          ? item.msg.replace(/^Value error,\s*/i, "").replace(/\.$/, "")
          : "";
        if (!msg) {
          continue;
        }
        if (loc.indexOf("email") !== -1 || /email/i.test(msg)) {
          emailFix();
        } else if (/required|missing/i.test(msg)) {
          add("fill in every required field");
        } else {
          add(msg.charAt(0).toLowerCase() + msg.slice(1));
        }
      }
    } else if (typeof detail === "string" && detail.trim()) {
      /* extra-forbid and similar rejections can arrive as a plain string
         detail — still a specific, non-generic "Please check the form" fix */
      var text = detail.trim().replace(/\.$/, "");
      if (/email/i.test(text)) {
        emailFix();
      } else {
        add(text.charAt(0).toLowerCase() + text.slice(1));
      }
    }

    if (!fixes.length) {
      return MSG_CHECK_FORM_FALLBACK;
    }
    return "Please check the form: " + fixes.join("; ") + ".";
  }

  /* reCAPTCHA Enterprise loader — injected only when the config requires it. */
  var recaptchaState = "idle"; /* idle | loading | ready | failed */

  /* Captcha readiness is NOT "grecaptcha.enterprise exists": Google attaches
     enterprise.execute later via a progressively loaded submodule, so a mere
     existence check raced the first submit ("grecaptcha.enterprise.execute
     is not a function", live 2026-10-03). Ready means execute is callable. */
  function recaptchaExecuteReady() {
    return !!(window.grecaptcha && window.grecaptcha.enterprise &&
      typeof window.grecaptcha.enterprise.execute === "function");
  }

  /* Wait for execute-readiness (150ms/40-tries poll, the pattern already used
     below): prefer the API's own ready() callback when present (finer-grained
     readiness signal), with the poll ALWAYS running as the guaranteed
     fallback/backstop — a one-shot guard lets whichever fires first win, so
     done()/failed() can never double-fire and the wait can never outlive the
     poll's timeout. If ready() fires before execute has attached, it is
     ignored and the poll keeps waiting. */
  function awaitRecaptchaExecute(done, failed, tries) {
    var settled = false;
    var timer = null;
    var win = function () {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearInterval(timer);
      }
      done();
    };
    var lose = function () {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearInterval(timer);
      }
      failed();
    };
    var enterprise = window.grecaptcha && window.grecaptcha.enterprise;
    if (enterprise && typeof enterprise.ready === "function") {
      enterprise.ready(function () {
        if (recaptchaExecuteReady()) {
          win();
        }
      });
    }
    timer = setInterval(function () {
      tries += 1;
      if (recaptchaExecuteReady()) {
        win();
      } else if (tries > 40) {
        lose();
      }
    }, 150);
  }

  function ensureRecaptcha(cfg, done, failed) {
    if (recaptchaExecuteReady()) {
      recaptchaState = "ready";
      done();
      return;
    }
    if (recaptchaState === "failed") {
      failed();
      return;
    }
    if (recaptchaState === "loading") {
      /* one loader only; poll briefly instead of stacking script tags */
      var tries = 0;
      var timer = setInterval(function () {
        tries += 1;
        if (recaptchaExecuteReady()) {
          clearInterval(timer);
          recaptchaState = "ready";
          done();
        } else if (tries > 40) {
          clearInterval(timer);
          recaptchaState = "failed";
          failed();
        }
      }, 150);
      return;
    }
    recaptchaState = "loading";
    var script = document.createElement("script");
    script.src = "https://www.google.com/recaptcha/enterprise.js?render="
      + encodeURIComponent(cfg.siteKey);
    script.async = true;
    script.onload = function () {
      if (recaptchaExecuteReady()) {
        recaptchaState = "ready";
        done();
        return;
      }
      /* script.onload is NOT execute-ready: the progressive submodule can
         still be attaching enterprise.execute — wait for it before done(). */
      awaitRecaptchaExecute(function () {
        recaptchaState = "ready";
        done();
      }, function () {
        recaptchaState = "failed";
        failed();
      }, 0);
    };
    script.onerror = function () {
      recaptchaState = "failed";
      failed();
    };
    document.head.appendChild(script);
  }

  function submitPayload(form, cfg, formData) {
    /* Exactly the §12 payload (backend schema extra:"forbid" — no other
       top-level keys may ever be added here). */
    var payload = {
      source: cfg.source,
      source_url: pageUrl(),
      session_id: ensureSessionId(),
      consent_version: cfg.consentVersion,
      form_data: formData
    };

    var email = extractEmail(form, formData);
    if (email) {
      payload.email = email; /* key omitted entirely when empty */
    }

    var request = function () {
      fetch(cfg.backendUrl.replace(/\/+$/, "") + "/api/v1/signups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (response) {
          return response.json().catch(function () {
            return null;
          }).then(function (body) {
            return { ok: response.ok, status: response.status, body: body };
          });
        })
        .then(function (result) {
          var status = result && result.status;
          var body = result && result.body;
          if (result && result.ok && status === 200) {
            writeStatus(form, MSG_SUCCESS, "is-success", false);
            return;
          }
          if (status === 422) {
            /* validation rejection: name the fix — never the generic failure
               text (per-field detail array or string detail both handled) */
            writeStatus(form, describeValidationError(body && body.detail), "is-error", true);
            return;
          }
          if (status === 429) {
            writeStatus(form, MSG_RATE_LIMIT, "is-error", true);
            return;
          }
          if (status === 400) {
            writeStatus(form, MSG_VERIFICATION, "is-error", true);
            return;
          }
          writeStatus(form, MSG_GENERIC, "is-error", true);
        })
        .catch(function (err) {
          if (err && err.name === "TypeError") {
            /* fetch rejects with TypeError on network failure — its own wording */
            writeStatus(form, MSG_UNREACHABLE, "is-error", true);
          } else {
            writeStatus(form, MSG_GENERIC, "is-error", true);
          }
        })
        .then(function () {
          inFlight = false;
        });
    };

    if (cfg.captchaRequired) {
      if (!cfg.siteKey) {
        /* malformed live config: no token can ever be obtained — honest
           verification wording, no loader request, no POST */
        writeStatus(form, MSG_VERIFICATION, "is-error", true);
        inFlight = false;
        return;
      }
      ensureRecaptcha(cfg, function () {
        window.grecaptcha.enterprise
          .execute(cfg.siteKey, { action: "signup" })
          .then(function (token) {
            payload.captcha_token = token;
            request();
          })
          .catch(function () {
            writeStatus(form, MSG_VERIFICATION, "is-error", true);
            inFlight = false;
          });
      }, function () {
        writeStatus(form, MSG_UNREACHABLE, "is-error", true);
        inFlight = false;
      });
    } else {
      request();
    }
  }

  var form = document.querySelector("form[data-signup]");
  if (!form) {
    return;
  }

  var inFlight = false;

  function attemptSubmit() {
    /* re-check the gate at submit time: inert unless a live config and a
       status region both exist (2026-10-01 hardening) */
    var cfg = readConfig();
    if (!cfg) {
      return;
    }
    if (!form.querySelector('[role="status"]')) {
      return;
    }
    if (inFlight) {
      return;
    }

    clearStatus(form);
    inFlight = true;
    submitPayload(form, cfg, collectFormData(form));
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    /* Enter in the email input fires implicit submission (native constraint
       validation runs first: an empty required field never reaches this). */
    attemptSubmit();
  });

  /* The certified submit control is <button type="button"> — its click never
     fires a native submit event, so the live path also listens for form-level
     clicks on button-like targets (delegated; type="reset" excluded). */
  form.addEventListener("click", function (event) {
    if (!event.target || !event.target.closest) {
      return;
    }
    var button = event.target.closest("button, input[type=\"button\"], input[type=\"submit\"]");
    if (!button || !form.contains(button)) {
      return;
    }
    if (button.getAttribute("type") === "reset") {
      return;
    }
    event.preventDefault(); /* live pages: no native action — this form posts via fetch */
    attemptSubmit();
  });
})();
