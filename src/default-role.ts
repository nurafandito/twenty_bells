import {
  defineApplicationRole,
  RowLevelPermissionPredicateOperand,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  SystemPermissionFlag,
} from 'twenty-sdk/define';

import {
  APP_DISPLAY_NAME,
  DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  FEED_READ_STATE_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

const OPPORTUNITY = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity;
const COMPANY = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company;
const TASK = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.task;
const CURRENT_MEMBER =
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember.fields.id
    .universalIdentifier;

// Row-level permissions are a premium feature of the Organization plan. The
// predicates below sync on every plan and are simply inert on Community — so
// the same build enforces server-side where the plan allows it, and the panel
// falls back to filtering in the browser where it does not. Verified on a
// Community instance: the predicates create fine and change nothing.
export default defineApplicationRole({
  universalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  label: `${APP_DISPLAY_NAME} default function role`,
  description: `${APP_DISPLAY_NAME} default function role`,
  // The panel reads widely — timeline, attachments, tasks, notes, their links
  // and workspace members — but writes exactly one thing: the reader's own
  // "last seen" marker. Write access is scoped to that object instead of the
  // whole workspace, so installing the app cannot cost a workspace its data.
  canReadAllObjectRecords: true,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  // `/rest/metadata/objects` (object/field labels, used to name custom objects
  // and render SELECT option colours) 403s without this — record-read access
  // alone does not cover metadata reads.
  permissionFlagUniversalIdentifiers: [SystemPermissionFlag.DATA_MODEL],
  objectPermissions: [
    {
      objectUniversalIdentifier: FEED_READ_STATE_OBJECT_UNIVERSAL_IDENTIFIER,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
  ],
  rowLevelPermissionPredicates: [
    {
      universalIdentifier: '7a5b1d02-6f43-4c8e-9a21-3d5e8c4b2f10',
      objectUniversalIdentifier: OPPORTUNITY.universalIdentifier,
      fieldUniversalIdentifier: OPPORTUNITY.fields.owner.universalIdentifier,
      operand: RowLevelPermissionPredicateOperand.IS,
      workspaceMemberFieldUniversalIdentifier: CURRENT_MEMBER,
    },
    {
      universalIdentifier: '2c9f4b83-51ad-4e26-9f0b-6a7d1e3c8b44',
      objectUniversalIdentifier: COMPANY.universalIdentifier,
      fieldUniversalIdentifier: COMPANY.fields.accountOwner.universalIdentifier,
      operand: RowLevelPermissionPredicateOperand.IS,
      workspaceMemberFieldUniversalIdentifier: CURRENT_MEMBER,
    },
    {
      universalIdentifier: 'e41d7a65-9c3b-4f18-8d52-0b6e2f9a7c31',
      objectUniversalIdentifier: TASK.universalIdentifier,
      fieldUniversalIdentifier: TASK.fields.assignee.universalIdentifier,
      operand: RowLevelPermissionPredicateOperand.IS,
      workspaceMemberFieldUniversalIdentifier: CURRENT_MEMBER,
    },
  ],
});
