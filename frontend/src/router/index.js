import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue')
  },
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: { title: '数据概览' }
      },
      {
        path: 'customers',
        name: 'Customers',
        component: () => import('@/views/customers/CustomerList.vue'),
        meta: { title: '客户管理' }
      },
      {
        path: 'customers/:id',
        name: 'CustomerDetail',
        component: () => import('@/views/customers/CustomerDetail.vue'),
        meta: { title: '客户详情' }
      },
      {
        path: 'customer-pool',
        name: 'CustomerPool',
        component: () => import('@/views/customers/CustomerPool.vue'),
        meta: { title: '公海客户' }
      },
      {
        path: 'customer-tags',
        name: 'CustomerTags',
        component: () => import('@/views/tags/CustomerTagList.vue'),
        meta: { title: '客户标签', roles: ['admin', 'super_admin', 'sales'] }
      },
      {
        path: 'opportunities',
        name: 'Opportunities',
        component: () => import('@/views/opportunities/OpportunityList.vue'),
        meta: { title: '商机管理' }
      },
      {
        path: 'contacts',
        name: 'Contacts',
        component: () => import('@/views/contacts/ContactList.vue'),
        // 售前（presales）、FDE（fde/fde_admin）无权访问，路由守卫会跳转到首页
        meta: { title: '联系人管理', roles: ['admin', 'super_admin', 'sales', 'operations'] }
      },
      {
        path: 'followups',
        name: 'Followups',
        component: () => import('@/views/followups/FollowupList.vue'),
        meta: { title: '跟进管理' }
      },
      {
        path: 'deliveries',
        name: 'Deliveries',
        component: () => import('@/views/deliveries/DeliveryList.vue'),
        meta: { title: '客户交付', roles: [] }
      },
      {
        path: 'contracts',
        name: 'Contracts',
        component: () => import('@/views/contracts/ContractList.vue'),
        // 售前（presales）、FDE（fde/fde_admin）无权访问，路由守卫会跳转到首页
        meta: { title: '合同管理', roles: ['admin', 'super_admin', 'sales', 'operations'] }
      },
      {
        path: 'payments',
        name: 'Payments',
        component: () => import('@/views/payments/PaymentList.vue'),
        meta: { title: '回款管理', roles: ['admin', 'super_admin', 'sales', 'operations'] }
      },
      {
        path: 'channels',
        name: 'Channels',
        component: () => import('@/views/channels/ChannelList.vue'),
        meta: { title: '渠道管理', roles: ['admin', 'super_admin', 'sales', 'operations'] }
      },
      {
        path: 'costs',
        name: 'Costs',
        component: () => import('@/views/costs/CostList.vue'),
        meta: { title: '成本管理', roles: ['admin', 'super_admin', 'operations'] }
      },
      {
        path: 'products',
        name: 'Products',
        component: () => import('@/views/products/ProductList.vue'),
        meta: { title: '产品管理', roles: ['admin', 'super_admin', 'operations'] }
      },
      {
        path: 'stats',
        name: 'Statistics',
        component: () => import('@/views/stats/Statistics.vue'),
        meta: { title: '数据统计', roles: ['admin', 'super_admin', 'operations', 'fde_admin'] }
      },
      {
        path: 'users',
        name: 'Users',
        component: () => import('@/views/users/UserList.vue'),
        // FDE管理员（fde_admin）可访问，但仅能管理FDE角色用户（详见后端权限校验）
        meta: { title: '用户管理', roles: ['admin', 'super_admin', 'fde_admin'] }
      },
      {
        path: 'departments',
        name: 'Departments',
        component: () => import('@/views/departments/DepartmentList.vue'),
        meta: { title: '部门管理', roles: ['admin', 'super_admin'] }
      },
      {
        path: 'settings',
        name: 'SystemSettings',
        component: () => import('@/views/system/SystemSettings.vue'),
        meta: { title: '配置管理', roles: ['admin', 'super_admin'] }
      },
      {
        path: 'profile',
        name: 'Profile',
        component: () => import('@/views/Profile.vue'),
        meta: { title: '个人信息' }
      },
      {
        path: 'weekly-meeting',
        name: 'WeeklyMeeting',
        component: () => import('@/views/WeeklyMeeting.vue'),
        meta: { title: '开周会', roles: ['admin', 'super_admin', 'operations'] }
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  
  if (to.path !== '/login' && !token) {
    next('/login')
  } else if (to.path === '/login' && token) {
    next('/')
  } else if (to.meta.roles) {
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    next(to.meta.roles.includes(user.role) ? undefined : '/dashboard')
  } else {
    next()
  }
})

export default router
