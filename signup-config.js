/*
 * WentAround — signup configuration (LOCAL ENGINEERING STUB — comment only).
 *
 * This file deliberately contains NO code: window.__SHADOW_SIGNUP_CONFIG__
 * stays undefined on the local page, which keeps signup.js fully dormant.
 * The form is inert — nothing is bound, nothing is sent, nothing is stored,
 * and no success or error state is ever rendered here.
 *
 * On a live-signup deployment (the shadow-launches--deployed/ variant and
 * its publish repo ONLY — never this local engineering directory),
 * site-frontend-agent writes a real config into this file, shaped like:
 *
 *   window.__SHADOW_SIGNUP_CONFIG__ = {
 *     endpoint: "https://<signup-backend-host>/api/v1/signups",
 *     source:   "wentaround-launch",
 *     recaptchaSiteKey: "<reCAPTCHA Enterprise site key>"
 *   };
 *
 * Do not fill this file in under shadow-launches/ — the local page must
 * remain fully inert under the lab's two-state static-page contract.
 */
