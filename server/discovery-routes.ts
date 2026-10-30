import type { FastifyInstance } from 'fastify';
import type { DiscoveryService } from './discovery.js';
import { profileSchema, type Profile } from './discovery-profile.js';
export async function discoveryRoutes(admin: FastifyInstance, d: DiscoveryService) {
    const key = { type: 'string', pattern: '^[a-zA-Z0-9-]{16,80}$' }, revision = { type: 'integer', minimum: 1 }, uuid = { type: 'string', pattern: '^[a-f0-9-]{36}$' };
    const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
    const params = obj({ id: uuid }), candidateParams = obj({ id: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } });
    admin.get('/discovery/profile', async () => d.profile());
    admin.post<{Body:{url:string;expectedRevision:number}}>('/discovery/exclusions/resolve',{schema:{body:obj({url:{type:'string',minLength:1,maxLength:250},expectedRevision:revision})}},async req=>d.excludeRepository(req.body.url,req.body.expectedRevision));
    admin.put<{
        Body: {
            profile: Profile;
            expectedRevision: number;
            acknowledgeCost: boolean;
        };
    }>('/discovery/profile', { schema: { body: obj({ profile: profileSchema, expectedRevision: { type: 'integer', minimum: 0 }, acknowledgeCost: { type: 'boolean' } }) } }, async (req) => d.save(req.body.profile, req.body.expectedRevision, req.body.acknowledgeCost, 'OWNER'));
    admin.get('/discovery/runs', async () => ({ items: d.runs() }));
    admin.post<{
        Body: {
            requestKey: string;
            revision: number;
        };
    }>('/discovery/runs', { schema: { body: obj({ requestKey: key, revision }) } }, async (req, reply) => reply.code(202).send(d.start(req.body.requestKey, req.body.revision)));
    admin.get<{
        Params: {
            id: string;
        };
    }>('/discovery/runs/:id', { schema: { params } }, async (req) => d.run(req.params.id));
    admin.post<{
        Params: {
            id: string;
        };
    }>('/discovery/runs/:id/cancel', { schema: { params, body: obj({}) } }, async (req) => d.cancel(req.params.id));
    admin.get<{
        Querystring: {
            page?: string;
            filter?: string;
        };
    }>('/discovery/candidates', { schema: { querystring: obj({ page: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' }, filter: { type: 'string', enum: ['active', 'all', 'ignored'] } }, []) } }, async (req) => d.candidates(Number(req.query.page || 1), req.query.filter || 'active'));
    admin.get<{
        Params: {
            id: string;
        };
    }>('/discovery/candidates/:id', { schema: { params: candidateParams } }, async (req) => d.candidate(Number(req.params.id)));
    admin.post<{
        Params: {
            id: string;
        };
        Body: {
            action: string;
            expectedVersion: number;
        };
    }>('/discovery/candidates/:id/actions', { schema: { params: candidateParams, body: obj({ action: { type: 'string', enum: ['ignore', 'enable', 'favorite', 'unfavorite'] }, expectedVersion: { type: 'integer', minimum: 1 } }) } }, async (req) => d.action(Number(req.params.id), req.body.action, req.body.expectedVersion));
    admin.post<{
        Params: {
            id: string;
        };
        Body: {
            requestKey: string;
            revision: number;
            confirmNewAnalysis: boolean;
        };
    }>('/discovery/candidates/:id/select', { schema: { params: candidateParams, body: obj({ requestKey: key, revision, confirmNewAnalysis: { type: 'boolean' } }) } }, async (req, reply) => reply.code(202).send(d.select(Number(req.params.id), req.body.requestKey, req.body.revision, req.body.confirmNewAnalysis)));
    admin.post<{
        Params: {
            id: string;
        };
        Body: {
            requestKey: string;
            revision: number;
            acknowledgeCost: boolean;
        };
    }>('/discovery/candidates/:id/reevaluate', { schema: { params: candidateParams, body: obj({ requestKey: key, revision, acknowledgeCost: { const: true } }) } }, async (req, reply) => reply.code(202).send(d.reevaluate(Number(req.params.id), req.body.requestKey, req.body.revision, req.body.acknowledgeCost)));
    admin.get<{
        Params: {
            id: string;
        };
    }>('/discovery/selections/:id', { schema: { params } }, async (req) => d.selection(req.params.id));
    admin.post<{
        Params: {
            id: string;
        };
        Body: {
            hash: string;
            acknowledgeCost: boolean;
        };
    }>('/discovery/selections/:id/confirm', { schema: { params, body: obj({ hash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, acknowledgeCost: { const: true } }) } }, async (req) => d.confirm(req.params.id, req.body.hash, req.body.acknowledgeCost));
    admin.post<{
        Params: {
            id: string;
        };
    }>('/discovery/selections/:id/refresh', { schema: { params, body: obj({}) } }, async (req, reply) => reply.code(202).send(d.refreshSelection(req.params.id)));
}
