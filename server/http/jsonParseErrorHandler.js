/**
 * Turn body-parser JSON failures into `{ ok: false }` instead of Express HTML.
 */
export function jsonParseErrorHandler(err, req, res, next) {
  const parseFailed =
    err?.type === 'entity.parse.failed' ||
    (err instanceof SyntaxError && err.status === 400 && 'body' in err);
  if (!parseFailed) {
    next(err);
    return;
  }
  res.status(400).json({
    ok: false,
    code: 'INVALID_JSON',
    error: 'Request body must be valid JSON.',
  });
}
