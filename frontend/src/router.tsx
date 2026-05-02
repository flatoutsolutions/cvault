import { ConvexQueryClient } from '@convex-dev/react-query'
import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { routerWithQueryClient } from '@tanstack/react-router-with-query'
import type { ConvexReactClient } from 'convex/react'

import { env } from './lib/env'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const convexQueryClient = new ConvexQueryClient(env.VITE_CONVEX_URL)

  const queryClient: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
      },
    },
  })
  convexQueryClient.connect(queryClient)

  const router = routerWithQueryClient(
    createRouter({
      routeTree,
      defaultPreload: 'intent',
      context: { queryClient, convexClient: convexQueryClient.convexClient },
      scrollRestoration: true,
      defaultNotFoundComponent: () => (
        <div className="flex min-h-screen flex-col items-center justify-center p-8">
          <h1 className="mb-4 text-4xl font-bold">404 - Page Not Found</h1>
          <p className="text-lg text-gray-600">The page you are looking for does not exist.</p>
        </div>
      ),
    }),
    queryClient
  )

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}

export type RouterContext = {
  queryClient: QueryClient
  convexClient: ConvexReactClient
}
