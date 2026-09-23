/**
 * The discovery-engine control API — which media engines a tenant wants used.
 *
 * # What a caller is setting, and what they are not
 *
 * They are setting a **switch**: may this service use this engine on our searches? That is a
 * coverage preference, and it is theirs.
 *
 * They are **not** setting `governanceStatus`. That is a reading of the engine's upstream terms
 * of use, it is platform-wide because somebody else's terms do not vary by customer, and it is
 * not writable through this API at all — it is not in the request schema. Every response carries
 * it beside the switch so that a caller turning an engine on can see what is known about it.
 * `effectiveEnabled` makes the platform enforcement explicit: a tenant preference never
 * overrides `REFUSED`.
 *
 * # Why the response is heavier than the request
 *
 * The request is two fields. The response carries the whole matrix row — the reading, the
 * decision id, who reviewed it and when, whether SearXNG uses the publisher's documented API, and
 * the evidence note. A control surface that showed only on/off would let somebody enable an
 * engine without ever being shown that a closed decision refused it, and the switch would then be
 * a decision nobody made knowingly.
 */

import { z } from 'zod';

/** The engines the connector integrates. A closed list: a free string would accept a typo. */
export const discoveryEngineSchema = z.enum([
  'GOOGLE_NEWS',
  'BING_NEWS',
  'BRAVE_NEWS',
  'DUCKDUCKGO_NEWS',
  'REUTERS',
  'WIKINEWS',
]);

export type DiscoveryEngineName = z.infer<typeof discoveryEngineSchema>;

/**
 * Where the platform's reading of this engine's upstream terms stands.
 *
 * Read-only over this API. `PENDING` means nobody has read them — it is not a softer form of
 * `PERMITTED`, and the API will not let a caller convert one into the other.
 */
export const engineGovernanceStatusSchema = z.enum(['PERMITTED', 'REFUSED', 'PENDING']);

export const discoveryEngineSettingSchema = z
  .object({
    engine: discoveryEngineSchema,
    /** What the SearXNG instance calls it, so a report can be matched against its `/config`. */
    searxngEngineName: z.string(),
    /**
     * Whether this connector can query and report the engine at all.
     *
     * A fact about our code, not about permission. It stays `true` for an engine that is
     * switched off, which is why a disabled engine still appears in every diagnostic with an
     * outcome rather than vanishing from the report.
     */
    integrated: z.boolean(),
    /** The tenant's requested switch. This cannot override a REFUSED governance reading. */
    tenantEnabled: z.boolean(),
    /** The execution gate after integration, tenant preference, and governance are combined. */
    effectiveEnabled: z.boolean(),
    /** True when this tenant has set a preference; false when the platform default applies. */
    configuredByTenant: z.boolean(),
    defaultEnabledForDiscovery: z.boolean(),
    /** The platform's reading of the upstream terms. Never writable through this API. */
    governanceStatus: engineGovernanceStatusSchema,
    /** The decision that records that reading — `D20`, `D21`. */
    decisionId: z.string(),
    reviewedAt: z.string(),
    /** Null when nobody has reviewed the engine. Null and `PENDING` go together. */
    reviewedBy: z.string().nullable(),
    /**
     * Whether SearXNG reads this engine through the publisher's own documented API.
     *
     * The single most useful fact for somebody deciding whether to switch it on, and the reason
     * it is on the response rather than buried in a document: `false` means we would be reading
     * an endpoint the publisher does not document for this use.
     */
    usesPublisherDocumentedApi: z.boolean(),
    /** What the research found, in full. Shown beside the switch, not linked to. */
    evidenceNote: z.string(),
    /** Who last changed this tenant's setting, and why. Absent while the default applies. */
    changedBy: z.string().optional(),
    reason: z.string().optional(),
    changedAt: z.string().optional(),
  })
  .strict();

export type DiscoveryEngineSetting = z.infer<typeof discoveryEngineSettingSchema>;

export const discoveryEngineListSchema = z
  .object({
    engines: z.array(discoveryEngineSettingSchema),
    /**
     * How many are effectively enabled after governance enforcement.
     *
     * Zero is a legitimate state and means adverse-media discovery is off for this tenant: every
     * search reports the source as `REFUSED` / `NO_ENGINE_PERMITTED` and says so on the coverage
     * line. It is never silently read as "nothing was found".
     */
    enabledCount: z.number().int().nonnegative(),
  })
  .strict();

export type DiscoveryEngineList = z.infer<typeof discoveryEngineListSchema>;

/**
 * Setting one engine's switch.
 *
 * `reason` is **required and non-empty**, and that is not a form nicety. Switching an engine on
 * accepts that this service will query a third party on this tenant's behalf; a settings row that
 * cannot say why it was set is not a record of a decision, it is a value that appeared. It
 * follows `firstContactApproval` rather than an ordinary preferences endpoint, and it is written
 * to the audit trail with the calling principal attached.
 */
export const setDiscoveryEngineSchema = z
  .object({
    enabled: z.boolean(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type SetDiscoveryEngine = z.infer<typeof setDiscoveryEngineSchema>;
