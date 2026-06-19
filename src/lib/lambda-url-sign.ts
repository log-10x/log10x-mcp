/**
 * SigV4 signing for the Lambda-flavor retriever's query Function URL.
 *
 * The Lambda retriever flavor (backend/terraform/demo/retriever-lambda.tf)
 * exposes its `query` role behind a Lambda Function URL with AWS_IAM auth, not
 * an open HTTP endpoint like the K8s/Quarkus flavor's NLB. So when the
 * configured retriever URL is a Function URL, the MCP must sign the POST with
 * SigV4 (service "lambda") using the standard AWS credential chain.
 *
 * Detection is by hostname shape (`*.lambda-url.<region>.on.aws`), so flipping
 * the demo between flavors is pure config: point __SAVE_LOG10X_RETRIEVER_URL__
 * at the Function URL (+ the lambda flavor's bucket) and the MCP signs
 * automatically — no flag.
 */

import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const LAMBDA_URL_HOST_RE = /\.lambda-url\.([a-z0-9-]+)\.on\.aws$/i;

/** True when the URL is a Lambda Function URL (so SigV4 is required). */
export function isLambdaFunctionUrl(url: string): boolean {
  try {
    return LAMBDA_URL_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Region embedded in a Lambda Function URL hostname, or null. */
export function lambdaUrlRegion(url: string): string | null {
  try {
    const m = new URL(url).hostname.match(LAMBDA_URL_HOST_RE);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// One signer per region; the credential provider caches/refreshes internally.
const signerCache = new Map<string, SignatureV4>();
function signerFor(region: string): SignatureV4 {
  let s = signerCache.get(region);
  if (!s) {
    s = new SignatureV4({
      service: 'lambda',
      region,
      credentials: fromNodeProviderChain(),
      sha256: Sha256,
    });
    signerCache.set(region, s);
  }
  return s;
}

/**
 * SigV4-sign and POST a JSON body to a Lambda Function URL, returning the
 * fetch Response. The Function URL IS the query endpoint (no extra path);
 * the handler reads the request body as the query payload.
 */
export async function signedLambdaUrlPost(url: string, jsonBody: string): Promise<Response> {
  const region = lambdaUrlRegion(url);
  if (!region) throw new Error(`not a lambda function url: ${url}`);
  const u = new URL(url);

  const request = new HttpRequest({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname || '/',
    headers: {
      'content-type': 'application/json',
      // host is required in the canonical request; SignatureV4 also sets it.
      host: u.hostname,
    },
    body: jsonBody,
  });

  const signed = await signerFor(region).sign(request);

  return fetch(url, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body: jsonBody,
  });
}
