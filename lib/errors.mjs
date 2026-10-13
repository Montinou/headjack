export class UserError extends Error {}
// stdin ended while a prompt waited for an answer; aborts the whole command instead of one entry.
export class EofError extends UserError {}
export class ConflictError extends Error {}
export class ForbiddenError extends Error {
  name = 'ForbiddenError';
}
