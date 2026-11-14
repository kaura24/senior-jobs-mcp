import { createRemoteJWKSet, jwtVerify } from 'jose';
export const identity = Object.freeze({
  issuer: 'https://oidc.vercel.com/kaura24-7661s-projects',
  audience: 'https://vercel.com/kaura24-7661s-projects',
  subject: 'owner:kaura24-7661s-projects:project:senior-jobs-poc-mcp:environment:production',
  owner: 'kaura24-7661s-projects', owner_id: 'team_3iBzdDdHq3kkOXM9uhOYxwJu',
  project: 'senior-jobs-poc-mcp', project_id: 'prj_5r5fRoQPxE0Xo1VGNwY8BNyBW4FK', environment: 'production',
});
export const remoteKeys = createRemoteJWKSet(new URL(identity.issuer + '/.well-known/jwks'),
  { timeoutDuration: 4000, cacheMaxAge: 600000, cooldownDuration: 30000 });
export async function authorize(request, keys = remoteKeys) {
  const header = request.headers.get('authorization');
  if (!header || !/^Bearer [A-Za-z0-9_.-]{20,16000}$/.test(header)) return false;
  try {
    const { payload } = await jwtVerify(header.slice(7), keys, { algorithms: ['RS256'],
      issuer: identity.issuer, audience: identity.audience, subject: identity.subject,
      requiredClaims: ['exp', 'iat', 'nbf'], maxTokenAge: '2h', clockTolerance: 0 });
    return ['owner', 'owner_id', 'project', 'project_id', 'environment'].every(key => payload[key] === identity[key]);
  } catch { return false; }
}
