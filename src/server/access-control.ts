import { timingSafeEqual } from "node:crypto";
import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

/** 起動ごとに発行するアクセストークン（256bit、base64url）。 */
export const generateToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export class ForbiddenHostError extends ErrorFactory({
  name: "ForbiddenHostError",
  message: (fields) => `Forbidden host: ${fields.host}`,
  fields: ErrorFactory.fields<{ host: string }>(),
}) {}

export class ForbiddenOriginError extends ErrorFactory({
  name: "ForbiddenOriginError",
  message: (fields) => `Forbidden origin: ${fields.origin}`,
  fields: ErrorFactory.fields<{ origin: string }>(),
}) {}

export class InvalidTokenError extends ErrorFactory({
  name: "InvalidTokenError",
  message: "Missing or invalid access token",
}) {}

export type AccessError =
  | ForbiddenHostError
  | ForbiddenOriginError
  | InvalidTokenError;

const allowedHosts = (port: number) =>
  new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

/** DNS rebinding 対策: Host ヘッダが自分自身を指しているか。 */
export const checkHost = (
  request: Request,
  port: number,
): Result.Result<void, ForbiddenHostError> => {
  const host = request.headers.get("host") ?? "";
  return allowedHosts(port).has(host)
    ? Result.succeed()
    : Result.fail(new ForbiddenHostError({ host }));
};

/** CSRF 対策: Origin ヘッダがあれば、自分自身のオリジンか。無ければ（ブラウザ以外）通す。 */
export const checkOrigin = (
  request: Request,
  port: number,
): Result.Result<void, ForbiddenOriginError> => {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return Result.succeed();
  }
  const allowed = [...allowedHosts(port)].map((host) => `http://${host}`);
  return allowed.includes(origin)
    ? Result.succeed()
    : Result.fail(new ForbiddenOriginError({ origin }));
};

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** `Authorization: Bearer <token>` を検証する。 */
export const checkToken = (
  request: Request,
  token: string,
): Result.Result<void, InvalidTokenError> => {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] !== undefined && safeEqual(match[1], token)
    ? Result.succeed()
    : Result.fail(new InvalidTokenError());
};

/** トークン以外の検証（Host / Origin）。API 以外のエンドポイントにも使う。 */
export const checkLocalRequest = (
  request: Request,
  port: number,
): Result.Result<void, ForbiddenHostError | ForbiddenOriginError> =>
  Result.pipe(
    checkHost(request, port),
    Result.andThen(() => checkOrigin(request, port)),
  );

/**
 * API リクエストに必要な検証をまとめて行う。
 * `token` が null（MONET_NO_AUTH=1 のデバッグモード）のときはトークンを検証しないが、Host / Origin は検証する。
 */
export const checkApiRequest = (
  request: Request,
  options: { port: number; token: string | null },
): Result.Result<void, AccessError> =>
  Result.pipe(
    checkLocalRequest(request, options.port),
    Result.andThen(() =>
      options.token === null
        ? Result.succeed()
        : checkToken(request, options.token),
    ),
  );

/** 検証エラーを HTTP レスポンスにする。詳細はクライアントに返さない。 */
export const accessErrorResponse = (error: AccessError): Response =>
  error.name === "InvalidTokenError"
    ? new Response("Unauthorized", { status: 401 })
    : new Response("Forbidden", { status: 403 });
