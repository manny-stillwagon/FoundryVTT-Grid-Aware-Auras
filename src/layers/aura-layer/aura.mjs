/** @import { AuraConfig, AuraConfigWithRadius } from "../../data/aura.mjs" */
/** @import { AuraGeometry } from "./geometry/index.mjs" */
import { MODULE_NAME, SQUARE_GRID_MODE_SETTING } from "../../consts.mjs";
import { auraDefaults, auraVisibilityDefaults } from "../../data/aura.mjs";
import { PolygonGraphic } from "../../shared/pixi/polygon-graphic.mjs";
import { pickProperties } from "../../utils/misc-utils.mjs";
import {
  GridlessAuraGeometry,
  HexagonalAuraGeometry,
  SquareAuraGeometry,
} from "./geometry/index.mjs";

/**
 * Class that manages a single aura.
 */
export class Aura {
  /** @type {Token} */
  #token;

  /** @type {AuraConfig} */
  #config;

  /** @type {number | undefined} */
  #radius;

  /** @type {number | undefined} */
  #innerRadius;

  #isVisible = false;

  /** @type {PolygonGraphic} */
  #graphics;

  /**
   * The geometry of the aura, relative to the token position.
   * Will be null if there is no valid geometry.
   * @type {AuraGeometry | null}
   */
  #geometry = null;

  /**
   * The inner geometry of the aura (its hole), relative to the token position.
   * Will be null if there is no hole.
   * @type {AuraGeometry | null}
   */
  #innerGeometry = null;

  #boundTick;

  /** @param {Token} token */
  constructor(token) {
    this.#token = token;
    this.#graphics = new PolygonGraphic();
    this.#graphics.sortLayer = 690; // Render just below tokens
    this.#boundTick = this.#graphics.tick.bind(this.#graphics);
  }

  get graphics() {
    return this.#graphics;
  }

  get config() {
    return this.#config;
  }

  get geometry() {
    return this.#geometry;
  }

  get innerGeometry() {
    return this.#innerGeometry;
  }

  /**
   * Updates this aura graphic, and redraws it if required.
   * @param {AuraConfigWithRadius} config
   * @param {Object} [options]
   * @param {Record<string, any>} [options.tokenDelta] If provided, uses the properties from this instead of the token
   * @param {boolean} [options.force] Force a redraw, even if no aura properties have changed.
   * @returns {boolean} `true` if the something has changed, `false` if nothing has changed.
   */
  update(config, { tokenDelta, force = false } = {}) {
    const shouldRedraw =
      force ||
      !foundry.utils.objectsEqual(this.#config, config) ||
      this.#radius !== config.radiusCalculated ||
      this.#innerRadius !== config.innerRadiusCalculated ||
      (!!tokenDelta &&
        ("width" in tokenDelta ||
          "height" in tokenDelta ||
          "shape" in tokenDelta));

    this.#config = config;
    this.#radius = config.radiusCalculated;
    this.#innerRadius = config.innerRadiusCalculated;

    const positionChanged = this.updatePosition({ tokenDelta });

    // If a relevant property has changed, do a redraw
    if (shouldRedraw || force) {
      const { width, height, shape } = pickProperties(
        ["width", "height", "shape"],
        tokenDelta,
        this.#token.document,
      );
      this.#redraw(
        width,
        height,
        config.radiusCalculated,
        config.innerRadiusCalculated,
        shape,
      );
    }

    const visibilityChanged = this.updateVisibility();

    return shouldRedraw || positionChanged || visibilityChanged;
  }

  /**
   * @param {Object} [options]
   * @param {Record<string, any>} [options.tokenDelta] If provided, uses the properties from this instead of the token
   * @returns {boolean} `true` if the position has changed, `false` if not.
   */
  updatePosition({ tokenDelta } = {}) {
    const { x: previousX, y: previousY } = this.graphics;
    const previousElevation = this.#graphics.elevation;

    Object.assign(this.#graphics, this.#getOffset(tokenDelta, this.#token));
    this.#graphics.elevation =
      tokenDelta?.elevation ?? this.#token.document.elevation;

    const hasChanged =
      this.#graphics.x !== previousX ||
      this.#graphics.y !== previousY ||
      this.graphics.elevation !== previousElevation;

    return hasChanged;
  }

  /** @returns {boolean} `true` if the visibility was changed, `false` if it has not changed. */
  updateVisibility() {
    // Transition opacity
    const wasVisible = this.#isVisible;
    this.#isVisible = this.#getVisibility();
    this.#graphics.alpha = this.#isVisible ? 1 : 0;
    return this.#isVisible !== wasVisible;
  }

  /**
   * Determines whether the given coordinate is inside this aura or not.
   * @param {Token} targetToken
   * @param {Object} [options]
   * @param {{ x?: number; y?: number; }} [options.sourceTokenPosition] If provided, treats the token that owns the
   * aura as being at this position. If not provided, falls back to the Token or TokenDocument position.
   * @param {boolean} [options.useActualSourcePosition] If false (default), uses the position of the token document.
   * If true, uses the actual position of the token on the canvas.
   * @param {{ x: number; y: number }} [options.targetTokenPosition] If provided, treats the target token as if it
   * were at these coordinates instead.
   */
  isInside(
    targetToken,
    {
      sourceTokenPosition,
      useActualSourcePosition = false,
      targetTokenPosition,
    } = {},
  ) {
    if (!this.#geometry) return false;

    // Need to offset by token position, as the geometry is relative to token position, not relative to canvas pos
    const auraOffset = this.#getOffset(
      sourceTokenPosition,
      useActualSourcePosition ? this.#token : this.#token.document,
    );

    // Token is inside the aura if it is partially inside the outer geometry and not totally inside the inner geometry.
    return (
      this.#geometry.isInside(targetToken, {
        auraOffset,
        tokenAltPosition: targetTokenPosition,
        mode: "partial",
      }) &&
      !this.#innerGeometry?.isInside(targetToken, {
        auraOffset,
        tokenAltPosition: targetTokenPosition,
        mode: "total",
      })
    );
  }

  destroy(...args) {
    canvas.app.ticker.remove(this.#boundTick);
    this.#graphics.destroy(...args);
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {number} radius
   * @param {number} innerRadius
   * @param {number} shape
   */
  async #redraw(width, height, radius, innerRadius, shape) {
    const auraConfig = { ...auraDefaults(), ...this.#config };

    // If there is a positional offset (i.e. aura is non-central), then use 0 as the effective token width/height.
    if (this.#getPositionOffset()) {
      width = 0;
      height = 0;
    } else {
      width ??= this.#token.document.width;
      height ??= this.#token.document.height;
    }

    shape ??= this.#token.document.shape;

    // Auras with negative radii are not rendered, neither are those where the innerRadius >= radius.
    if (
      typeof radius !== "number" ||
      radius < 0 ||
      (typeof innerRadius === "number" && innerRadius >= radius)
    ) {
      this.#graphics.clear();
      this.#geometry = null;
      this.#innerGeometry = null;
      return;
    }

    // Set an upper limit for radius.
    // This is fairly arbitrary, but if it's too high, the browser can crash trying to generate geometry.
    radius = Math.min(radius, 1000);

    this.#geometry = createGeometry(radius);
    this.#innerGeometry =
      typeof innerRadius === "number" && innerRadius >= 0
        ? createGeometry(innerRadius)
        : null;

    if (!this.#geometry) {
      this.#graphics.clear();
      return;
    }

    // Load the texture BEFORE clearing, otherwise there's a noticable flash every time something is changed.
    const texture =
      auraConfig.fillType === CONST.DRAWING_FILL_TYPES.PATTERN
        ? await loadTexture(auraConfig.fillTexture)
        : null;

    this.#graphics.update(
      {
        lineType: auraConfig.lineType,
        lineWidth: auraConfig.lineWidth,
        lineColor: Color.from(auraConfig.lineColor),
        lineColorAnimation: auraConfig.lineColorAnimation,
        lineOpacity: auraConfig.lineOpacity,
        lineDashSize: auraConfig.lineDashSize,
        lineGapSize: auraConfig.lineGapSize,
        lineDashOffsetAnimation: auraConfig.lineDashOffsetAnimation,
        fillType: auraConfig.fillType,
        fillColor: Color.from(auraConfig.fillColor),
        fillColorAnimation: auraConfig.fillColorAnimation,
        fillOpacity: auraConfig.fillOpacity,
        fillTexture: texture,
        fillTextureOffset: auraConfig.fillTextureOffset,
        fillTextureOffsetAnimation: auraConfig.fillTextureOffsetAnimation,
        fillTextureScale: auraConfig.fillTextureScale,
      },
      [...this.#geometry.getPath()],
      this.#innerGeometry ? [[...this.#innerGeometry.getPath()]] : [],
      this.#geometry.bounds,
    );

    canvas.app.ticker.add(this.#boundTick);

    /**
     * Creates a geometry of the specified radius for the current grid type and scoped token size/shape.
     * @param {number} r
     */
    function createGeometry(r) {
      switch (canvas.grid.type) {
        case CONST.GRID_TYPES.GRIDLESS:
          return new GridlessAuraGeometry(width, height, r, canvas.grid.size);

        case CONST.GRID_TYPES.SQUARE:
          return new SquareAuraGeometry(
            width,
            height,
            r,
            game.settings.get(MODULE_NAME, SQUARE_GRID_MODE_SETTING),
            canvas.grid.size,
          );

        default: // hexagonal
          return new HexagonalAuraGeometry(
            width,
            height,
            r,
            shape,
            [CONST.GRID_TYPES.HEXEVENQ, CONST.GRID_TYPES.HEXODDQ].includes(
              canvas.grid.type,
            ),
            canvas.grid.size,
          );
      }
    }
  }

  /**
   * Gets the render offset for the aura graphics.
   * Will use the first X and Y positions found in the positions array as the token's current position.
   * @param {...{ x?: number; y?: number; }?} positions
   */
  #getOffset(...positions) {
    /** @type {{ x: number; y: number }} */
    let { x, y } = pickProperties(["x", "y"], ...positions);

    // If the token has a size of < 1 on a non-gridless scen), then we need to snap the aura to the nearest grid cell
    const { width, height } = this.#token.document;
    if (
      (width < 1 || height < 1) &&
      canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS
    ) {
      const gridCoords = canvas.grid.getOffset({
        x: x + this.#token.w / 2,
        y: y + this.#token.h / 2,
      });

      ({ x, y } = canvas.grid.getTopLeftPoint(gridCoords));
    }

    // If the position of the aura is non-central, then apply the relevant offset
    const positionOffset = this.#getPositionOffset();
    if (positionOffset !== undefined) {
      x += Math.max(width, 1) * positionOffset.x * canvas.grid.sizeX;
      y += Math.max(height, 1) * positionOffset.y * canvas.grid.sizeY;
    }

    return { x, y };
  }

  /** Gets the x and y offset as determined by the "position" config alone. */
  #getPositionOffset() {
    if (canvas.grid.type !== CONST.GRID_TYPES.SQUARE) return;

    const position = this.#config.position;
    switch (position) {
      case "TOP_LEFT":
        return { x: 0, y: 0 };
      case "TOP_RIGHT":
        return { x: 1, y: 0 };
      case "BOTTOM_RIGHT":
        return { x: 1, y: 1 };
      case "BOTTOM_LEFT":
        return { x: 0, y: 1 };
    }
  }

  /**
   * Determines whether this aura should be visible, based on it's config and assigned token.
   */
  #getVisibility() {
    // If token is hidden or set as invisible in config, then it is definitely not visible
    if (
      !this.#token.visible ||
      this.#token.hasPreview ||
      !this.#config.enabled
    ) {
      return false;
    }

    // Otherwise, determine the visibility based on either ownerVisibility or nonOwnerVisibility, depending on the
    // user's relationship to the token.
    //
    // For all flags other than default (e.g. targeted, hovered, etc.), we see if any of them are relevant now.
    // If any of the relevant ones are true, then the aura should be visible (OR logic).
    // Otherwise, if there are no relevant states (i.e. the token is not targeted AND not hovered, etc.) then use
    // the default visibility.
    // We use mergeObject so that if new states are added in future, they have their defaults handled correctly.
    const visibility = foundry.utils.mergeObject(
      auraVisibilityDefaults,
      this.#token.isOwner
        ? this.#config.ownerVisibility
        : this.#config.nonOwnerVisibility,
      { inplace: false },
    );

    let hasRelevantNonDefaultState = false;

    if (this.#token.hover) {
      if (visibility.hovered) return true;
      hasRelevantNonDefaultState = true;
    }

    if (this.#token.controlled) {
      if (visibility.controlled) return true;
      hasRelevantNonDefaultState = true;
    }

    if (this.#token.isPreview) {
      if (visibility.dragging) return true;
      hasRelevantNonDefaultState = true;
    }

    if (this.#token.isTargeted) {
      if (visibility.targeted) return true;
      hasRelevantNonDefaultState = true;
    }

    if (
      this.#token.inCombat &&
      this.#token.combatant?.combat?.current?.tokenId === this.#token.id
    ) {
      if (visibility.turn) return true;
      hasRelevantNonDefaultState = true;
    }

    return !hasRelevantNonDefaultState && visibility.default;
  }
}
