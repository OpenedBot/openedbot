/** Contrats HTTP publics partagés par l'API SaaS et ses clients. */

export const LEGAL_SLUGS = ["mentions", "privacy", "terms"] as const;

export type LegalSlug = (typeof LEGAL_SLUGS)[number];

type LegalCatalogEntryDto = {
  slug: LegalSlug;
  available: boolean;
};

export type LegalCatalogDto = { documents: LegalCatalogEntryDto[] };

export type LegalDocumentDto = {
  slug: LegalSlug;
  content: string;
  contentType: "text/markdown";
};

/** `POST /api/waitlist` : `joined` à la première inscription, `already` ensuite. */
export type WaitlistJoinDto = { status: "joined" | "already" };
