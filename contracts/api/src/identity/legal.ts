/** Public HTTP contracts shared by the SaaS API and its clients. */

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

