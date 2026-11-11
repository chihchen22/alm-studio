// apps/studio/src/companion.ts
/**
 * The one import point of the optional extension folder in the Studio. An eager glob: with the pack present its
 * register module runs here and adds its screens, tabs, headline and card to src/registry.ts; with the pack absent the
 * glob matches nothing, so the build carries no pack code and nothing fails.
 */
const found = import.meta.glob("../../../companion/studio/register.tsx", { eager: true });

export const COMPANION_LOADED = Object.keys(found).length > 0;
