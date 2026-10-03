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
 * when a real signup-config.js defines
 *   window.__SHADOW_SIGNUP_CONFIG__ = { endpoint, source?, recaptchaSiteKey? }
 * this handler binds to <form data-signup>, POSTs email/source/session/
 * consent plus every raw form field as form_data (email optional — stored
 * when present), and renders the backend's verdict in the form's
 * [role="status"] element (2026-10-01 hardening: silently no-ops if the
 * form has no status region).
 *
 * Response mapping (2026-09-26 user direction — the frontend renders the
 * backend's verdict, it is not the validator):
 *   200            -> success text
 *   422 validation -> a specific "Please check the form" message that names
 *                     the fix (never the generic failure text)
 *   429            -> rate-limit wording
 *   400            -> verification/captcha wording
 *   captcha/network failure -> its own retry wording
 *   anything else  -> generic failure text
 * The reCAPTCHA Enterprise loader is injected lazily and ONLY when the
 * config carries a site key (first submit, never on page load). No cookies,
 * no page storage; the session id is held in memory for the page view only.
 */
(function () {
  "use strict";

  var liveConfig = window.__SHADOW_SIGNUP_CONFIG__;

  /* DORMANT GATE — no live config: bind nothing at all. */
  if (!liveConfig || !liveConfig.endpoint) {
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

  /* Collect every named field on the form; radio/checkbox only when checked. */
  function readFields(form) {
    var controls = form.querySelectorAll("input, select, textarea");
    var data = {};
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      if (!control.name || control.disabled) {
        continue;
      }
      if ((control.type === "radio" || control.type === "checkbox") && !control.checked) {
        continue;
      }
      data[control.name] = control.value;
    }
    return data;
  }

  /* Ephemeral page-view id, held in memory only (no persistence of any kind). */
  function makeSessionId() {
    var hex = "0123456789abcdef";
    var out = "";
    for (var i = 0; i < 32; i++) {
      out += hex.charAt(Math.floor(Math.random() * 16));
    }
    return out;
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

  function ensureRecaptcha(cfg, done, failed) {
    if (window.grecaptcha && window.grecaptcha.enterprise) {
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
        if (window.grecaptcha && window.grecaptcha.enterprise) {
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
      + encodeURIComponent(cfg.recaptchaSiteKey);
    script.async = true;
    script.onload = function () {
      recaptchaState = (window.grecaptcha && window.grecaptcha.enterprise) ? "ready" : "failed";
      if (recaptchaState === "ready") {
        done();
      } else {
        failed();
      }
    };
    script.onerror = function () {
      recaptchaState = "failed";
      failed();
    };
    document.head.appendChild(script);
  }

  function submitPayload(form, cfg, fields) {
    var payload = {
      email: typeof fields.email === "string" ? fields.email.trim() : "",
      source: cfg.source || window.location.href,
      session: makeSessionId(),
      consent: true,
      form_data: fields
    };

    var request = function () {
      fetch(cfg.endpoint, {
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
            /* validation rejection: name the fix — never the generic failure text */
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
        .catch(function () {
          writeStatus(form, MSG_UNREACHABLE, "is-error", true);
        })
        .then(function () {
          inFlight = false;
        });
    };

    if (cfg.recaptchaSiteKey) {
      ensureRecaptcha(cfg, function () {
        window.grecaptcha.enterprise
          .execute(cfg.recaptchaSiteKey, { action: "signup" })
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

  function formElSafe() {
    return document.querySelector("form[data-signup]");
  }

  var form = formElSafe();
  if (!form) {
    return;
  }

  var inFlight = false;

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    /* re-check the gate at submit time: inert unless a live config and a
       status region both exist (2026-10-01 hardening) */
    var cfg = window.__SHADOW_SIGNUP_CONFIG__;
    if (!cfg || !cfg.endpoint) {
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
    submitPayload(form, cfg, readFields(form));
  });
})();
