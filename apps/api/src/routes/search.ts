import { pageSchema, searchHitSchema, searchQuerySchema } from '@okf/shared';
import { errorResponses, type RoutePlugin } from '../types';

const routes: RoutePlugin = async (app, { deps }) => {
  app.get(
    '/search',
    {
      schema: {
        tags: ['search'],
        summary: 'Search the catalog',
        description:
          '`scope=datasets` matches dataset name, description, tags, owner organization, and indexed concept types, titles and schema column names. ' +
          '`scope=concepts` matches individual concepts (title, type, tags, description, body). Anonymous callers see public published datasets only. ' +
          'Snippets mark matches with U+0002/U+0003.',
        security: [],
        querystring: searchQuerySchema,
        response: { 200: pageSchema(searchHitSchema), ...errorResponses },
      },
    },
    async (req) => {
      const viewer = { userId: req.auth.user?.id ?? null, restrictToOrgId: req.auth.apiKey?.organizationId ?? null };
      return deps.search.search(viewer, req.query);
    },
  );
};

export default routes;
