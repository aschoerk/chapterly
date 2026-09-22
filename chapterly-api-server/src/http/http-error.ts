export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function notFound(entity: string, id: string): HttpError {
  return new HttpError(404, `${entity} not found: ${id}`);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}
