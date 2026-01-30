/**
 * Custom error types for better error handling
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class EmbeddingError extends AppError {
  constructor(message: string = 'Failed to generate embedding') {
    super(message, 500, 'EMBEDDING_ERROR');
    this.name = 'EmbeddingError';
  }
}

export class VectorStoreError extends AppError {
  constructor(message: string = 'Vector store operation failed') {
    super(message, 500, 'VECTOR_STORE_ERROR');
    this.name = 'VectorStoreError';
  }
}
