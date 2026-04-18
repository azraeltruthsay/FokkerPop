# UX Polish Plan

This plan finalizes the remaining stubbed features and improves the dashboard's user experience based on the latest review.

## Objective
To ensure all configured combos actually trigger visual effects, make it easier to test goal rewards, and streamline the Twitch authentication flow.

## Scope & Impact
- **Combos:** The `cheer.combo` (Bit Blitz/Burst) defined in `settings.example.json` currently has no mapped visual effects. This will be fixed.
- **Goals:** A "Test Reward" button will be added to each active goal in the dashboard so LilFokker can preview the effect.
- **Twitch Auth:** The popup window that appears during Twitch authentication will now automatically close itself upon success, rather than requiring manual closure.

## Implementation Steps

### Phase 1: Fix 'Cheer' Combos
1. **`server/pipeline/router.js`:**
   - Add a `'cheer.combo'` entry to the `EFFECT_MAP`.
   - It should trigger a `combo-display` effect (like `sub.combo` does).
   - It should also trigger a `firework-salvo` or `confetti` depending on the combo level.

### Phase 2: Goal Test Button
1. **`dashboard/app.js`:**
   - Modify the `renderGoals` function.
   - For each goal that has a valid `reward.effect`, append a `Test Reward` button to the UI row next to the toggle/reset buttons.
   - The button will trigger `dashSend({ type: '_dashboard.effect', effect: g.reward.effect, payload: {} })`.

### Phase 3: Auto-close Twitch Auth Popup
1. **`server/index.js`:**
   - Locate the `handleOAuthCallback` function.
   - In the successful token exchange response, inject `<script>setTimeout(() => window.close(), 1500);</script>` into the returned HTML so the user sees the success message briefly before the window closes automatically.

## Verification
- Use the dashboard's `Test Event` buttons to rapidly simulate bit cheers and verify the combo display appears.
- Click the "Test Reward" button on a goal and verify the correct effect triggers in the overlay.
- Trigger the Twitch auth flow, authorize the app, and verify the popup tab closes itself.
