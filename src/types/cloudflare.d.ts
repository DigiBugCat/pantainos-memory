/**
 * Type augmentation for Cloudflare Vectorize metadata.
 *
 * Vectorize API accepts nested objects in metadata at runtime,
 * but the TypeScript types are overly restrictive.
 * This augmentation allows our metadata interfaces to work correctly.
 */

// Extend the global VectorizeVectorMetadata to allow our metadata shapes
declare global {
  interface VectorizeVectorMetadataValue {
    // Allow nested objects for our metadata
    [key: string]: string | number | boolean | string[] | undefined;
  }
}

export {};
