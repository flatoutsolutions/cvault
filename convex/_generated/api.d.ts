/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as __tests___helpers from "../__tests__/helpers.js";
import type * as cli_actions from "../cli/actions.js";
import type * as cli_clerk from "../cli/clerk.js";
import type * as cli_httpMint from "../cli/httpMint.js";
import type * as cli_httpSync from "../cli/httpSync.js";
import type * as cli_internalReads from "../cli/internalReads.js";
import type * as cli_mintAction from "../cli/mintAction.js";
import type * as cli_syncAction from "../cli/syncAction.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as machineActivity_mutations from "../machineActivity/mutations.js";
import type * as machineActivity_queries from "../machineActivity/queries.js";
import type * as organizationMembers_actions from "../organizationMembers/actions.js";
import type * as organizations_actions from "../organizations/actions.js";
import type * as rateLimit_mutations from "../rateLimit/mutations.js";
import type * as refreshLog_mutations from "../refreshLog/mutations.js";
import type * as refreshLog_queries from "../refreshLog/queries.js";
import type * as subscriptions_actions from "../subscriptions/actions.js";
import type * as subscriptions_anthropic from "../subscriptions/anthropic.js";
import type * as subscriptions_crons from "../subscriptions/crons.js";
import type * as subscriptions_crypto from "../subscriptions/crypto.js";
import type * as subscriptions_internalReads from "../subscriptions/internalReads.js";
import type * as subscriptions_mutations from "../subscriptions/mutations.js";
import type * as subscriptions_queries from "../subscriptions/queries.js";
import type * as subscriptions_redact from "../subscriptions/redact.js";
import type * as users_actions from "../users/actions.js";
import type * as utils_auth from "../utils/auth.js";
import type * as utils_users from "../utils/users.js";
import type * as utils_validateRequest from "../utils/validateRequest.js";
import type * as webhooks_clerk from "../webhooks/clerk.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "__tests__/helpers": typeof __tests___helpers;
  "cli/actions": typeof cli_actions;
  "cli/clerk": typeof cli_clerk;
  "cli/httpMint": typeof cli_httpMint;
  "cli/httpSync": typeof cli_httpSync;
  "cli/internalReads": typeof cli_internalReads;
  "cli/mintAction": typeof cli_mintAction;
  "cli/syncAction": typeof cli_syncAction;
  crons: typeof crons;
  http: typeof http;
  "machineActivity/mutations": typeof machineActivity_mutations;
  "machineActivity/queries": typeof machineActivity_queries;
  "organizationMembers/actions": typeof organizationMembers_actions;
  "organizations/actions": typeof organizations_actions;
  "rateLimit/mutations": typeof rateLimit_mutations;
  "refreshLog/mutations": typeof refreshLog_mutations;
  "refreshLog/queries": typeof refreshLog_queries;
  "subscriptions/actions": typeof subscriptions_actions;
  "subscriptions/anthropic": typeof subscriptions_anthropic;
  "subscriptions/crons": typeof subscriptions_crons;
  "subscriptions/crypto": typeof subscriptions_crypto;
  "subscriptions/internalReads": typeof subscriptions_internalReads;
  "subscriptions/mutations": typeof subscriptions_mutations;
  "subscriptions/queries": typeof subscriptions_queries;
  "subscriptions/redact": typeof subscriptions_redact;
  "users/actions": typeof users_actions;
  "utils/auth": typeof utils_auth;
  "utils/users": typeof utils_users;
  "utils/validateRequest": typeof utils_validateRequest;
  "webhooks/clerk": typeof webhooks_clerk;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
