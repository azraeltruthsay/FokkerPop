// Per-widget-type defaults for the "claims space" flag.
//
// claimsSpace widgets are physical/spatial: they own a rectangular footprint
// on the overlay where another claimsSpace widget would visually collide
// (3D dice tumbling out of one pit clipping into another, for example). When
// two claimsSpace widgets are dragged or resized in Layout mode, the drag
// is constrained so they cannot overlap. Non-claimsSpace widgets (text,
// stickers, transient banners) ignore the rule entirely and can stack freely.
//
// Loaded as a plain script in both overlay.html and dashboard/index.html, so
// it sets globals rather than exporting an ES module.

(function () {
  const DEFAULTS = {
    'physics-pit':    true,
    'physics-pit-3d': true,
    'dice':           true,
    'dice-tray':      true,
    'hot-button-3d':  true,
    'model-3d':       true,
  };

  function claimsSpaceFor(widget) {
    if (!widget) return false;
    const override = widget.config?.claimsSpace;
    if (override !== undefined) return !!override;
    return !!DEFAULTS[widget.type];
  }

  window.WIDGET_CLAIMS_SPACE_DEFAULTS = DEFAULTS;
  window.widgetClaimsSpaceFor = claimsSpaceFor;
})();
