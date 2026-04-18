# Fake Chat & Redeem Simulator Plan

This plan outlines the addition of a Chat & Redeem Simulator to the dashboard, providing a robust test bed for simulating specific Twitch events and redeems without going live.

## Objective
To allow LilFokker to thoroughly test specific Channel Point Redeems, custom cheers, and chat interactions in a safe, offline environment.

## Scope & Impact
- **UI:** A new "Simulate Custom Event" panel will be added to the "Test Effects" page in the dashboard.
- **Functionality:** 
  - A dropdown to select active Channel Point Redeems and fire them.
  - A text input to simulate custom cheer amounts (e.g., 69 bits, 420 bits) with a custom message.
  - A way to simulate a custom gift sub amount.
- **Impact:** Complete offline confidence. LilFokker can test exactly how a specific redeem or specific bit amount will look on his overlay.

## Implementation Steps

### Phase 1: Dashboard UI (HTML)
1. **`dashboard/index.html`:**
   - In the `#page-effects` div, add a new `.card` section labeled "Simulate Custom Event".
   - Include a form for **Channel Point Redeem**: A `<select>` that populates dynamically with the keys from `redeems.json`, and a "Redeem" button.
   - Include a form for **Custom Cheer**: Inputs for Username, Bits Amount, and Message, and a "Cheer" button.
   - Include a form for **Custom Gift Subs**: Inputs for Username and Count, and a "Gift" button.

### Phase 2: Dashboard Logic (JS)
1. **`dashboard/app.js`:**
   - Add a function to fetch `/api/redeems` and populate the new Redeem `<select>` dropdown. This should be called on `connect()` or `refreshAll()`.
   - Add a `fireCustomRedeem()` function that triggers `fireEvent('redeem', { user: 'TestUser', rewardTitle: selectedTitle })`.
   - Add a `fireCustomCheer()` function that triggers `fireEvent('cheer', { user: username, bits: amount, message })`.
   - Add a `fireCustomGift()` function that triggers `fireEvent('sub.gifted', { user: username, count: amount })`.

## Verification
- Open the Test Effects tab.
- Verify the Redeem dropdown contains the options from the Config tab.
- Select a redeem and click "Fire Redeem", verifying the overlay reacts with the correct effect.
- Enter a custom bit amount (e.g., "777") with a message and verify the Cheer alert correctly displays the custom amount and text.
