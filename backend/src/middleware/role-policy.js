const { db } = require('../database');

const VALID_ROLES = ['sales', 'presales', 'fde', 'fde_admin', 'operations', 'admin', 'super_admin'];
const COMMERCIAL_ROLES = ['sales', 'admin', 'super_admin', 'operations'];
const TECHNICAL_ROLES = ['presales', 'fde', 'fde_admin'];

function isSystemAdmin(role) {
  return role === 'admin' || role === 'super_admin';
}

function canViewAll(role) {
  return isSystemAdmin(role) || role === 'operations' || role === 'fde_admin';
}

function isTechnicalRole(role) {
  return TECHNICAL_ROLES.includes(role);
}

function canSeeCommercial(role) {
  return COMMERCIAL_ROLES.includes(role);
}

function isCustomerMember(customerId, userId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM customers c
    WHERE c.id = ? AND c.is_deleted = 0 AND (
      c.owner_id = ? OR c.secondary_owner_id = ? OR
      EXISTS (SELECT 1 FROM customer_members cm WHERE cm.customer_id = c.id AND cm.user_id = ?) OR
      EXISTS (SELECT 1 FROM opportunities o WHERE o.customer_id = c.id AND o.owner_id = ?)
    )
  `).get(customerId, userId, userId, userId, userId));
}

// 指派类型 → 客户级指派表的映射
const CUSTOMER_ASSIGNMENT_TABLES = {
  presales: 'customer_presales_assignments',
  fde: 'customer_fde_assignments',
};

// 统一判断：商机级指派存在，或该商机所属客户存在对应类型的客户级活跃指派
function userCanAccessOpportunity(userId, opportunityId, assignmentType) {
  const customerTable = CUSTOMER_ASSIGNMENT_TABLES[assignmentType];
  if (!customerTable) return false;
  return Boolean(db.prepare(`
    SELECT 1 WHERE
      EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = ? AND oa.user_id = ? AND oa.assignment_type = ? AND oa.status = 'active')
      OR EXISTS (SELECT 1 FROM opportunities o
        JOIN ${customerTable} cpa ON cpa.customer_id = o.customer_id
        WHERE o.id = ? AND cpa.user_id = ? AND cpa.status = 'active')
      LIMIT 1
  `).get(opportunityId, userId, assignmentType, opportunityId, userId));
}

// 判断商机是否存在任意指定类型的活跃指派（商机级或客户级），供 fde_admin 等角色使用
function opportunityHasActiveAssignment(opportunityId, assignmentType) {
  const customerTable = CUSTOMER_ASSIGNMENT_TABLES[assignmentType];
  if (!customerTable) return false;
  return Boolean(db.prepare(`
    SELECT 1 WHERE
      EXISTS (SELECT 1 FROM opportunity_assignments oa
        WHERE oa.opportunity_id = ? AND oa.assignment_type = ? AND oa.status = 'active')
      OR EXISTS (SELECT 1 FROM opportunities o
        JOIN ${customerTable} cpa ON cpa.customer_id = o.customer_id
        WHERE o.id = ? AND cpa.status = 'active')
      LIMIT 1
  `).get(opportunityId, assignmentType, opportunityId));
}

// 售前访问商机的判断：商机级售前指派存在，或该商机所属客户存在客户级活跃售前指派
function presalesCanAccessOpportunity(userId, opportunityId) {
  return userCanAccessOpportunity(userId, opportunityId, 'presales');
}

function canViewCustomer(user, customerId) {
  if (canViewAll(user.role)) return true;
  if (user.role === 'sales') return isCustomerMember(customerId, user.id);
  if (user.role === 'presales') {
    return Boolean(db.prepare(`
      SELECT 1 FROM customers c WHERE c.id = ? AND c.is_deleted = 0 AND (
        EXISTS (SELECT 1 FROM customer_presales_assignments cpa WHERE cpa.customer_id = c.id AND cpa.user_id = ? AND cpa.status = 'active') OR
        EXISTS (SELECT 1 FROM opportunities o JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
          WHERE o.customer_id = c.id AND oa.user_id = ? AND oa.assignment_type = 'presales' AND oa.status = 'active')
      )
    `).get(customerId, user.id, user.id));
  }
  if (user.role === 'fde') {
    return Boolean(db.prepare(`
      SELECT 1 FROM customer_fde_assignments cfa
      WHERE cfa.customer_id = ? AND cfa.user_id = ? AND cfa.status = 'active'
      UNION SELECT 1 FROM opportunities o JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
      WHERE o.customer_id = ? AND oa.user_id = ? AND oa.assignment_type = 'fde' AND oa.status = 'active'
      LIMIT 1
    `).get(customerId, user.id, customerId, user.id));
  }
  if (user.role === 'fde_admin') {
    return Boolean(db.prepare(`
      SELECT 1 FROM customer_fde_assignments cfa
      WHERE cfa.customer_id = ? AND cfa.status = 'active'
      UNION SELECT 1 FROM opportunities o JOIN opportunity_assignments oa ON oa.opportunity_id = o.id
      WHERE o.customer_id = ? AND oa.assignment_type = 'fde' AND oa.status = 'active'
      LIMIT 1
    `).get(customerId, customerId));
  }
  return false;
}

function requirePolicy(predicate, message = '权限不足') {
  return (req, res, next) => {
    if (!predicate(req.user, req)) return res.status(403).json({ error: message });
    next();
  };
}

module.exports = {
  VALID_ROLES,
  COMMERCIAL_ROLES,
  TECHNICAL_ROLES,
  isSystemAdmin,
  canViewAll,
  isTechnicalRole,
  canSeeCommercial,
  isCustomerMember,
  presalesCanAccessOpportunity,
  userCanAccessOpportunity,
  opportunityHasActiveAssignment,
  canViewCustomer,
  requirePolicy
};
