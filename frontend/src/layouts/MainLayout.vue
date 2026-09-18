<template>
  <el-container class="layout-container">
    <el-aside :width="isCollapsed ? '64px' : '220px'" class="sidebar" :class="{ collapsed: isCollapsed }">
      <div class="logo" @click="isCollapsed = !isCollapsed">
        <img src="/logo.svg" alt="贝海" class="logo-icon" />
        <transition name="fade">
          <span v-if="!isCollapsed" class="logo-text">贝海 CRM</span>
        </transition>
      </div>

      <el-scrollbar class="menu-scrollbar">
        <el-menu
          :default-active="activeMenu"
          :collapse="isCollapsed"
          :collapse-transition="false"
          background-color="transparent"
          text-color="#1f2329"
          active-text-color="#3370ff"
          router
        >
          <div v-if="!isCollapsed" class="menu-group-title">工作台</div>
          <el-menu-item index="/dashboard">
            <el-icon><DataAnalysis /></el-icon>
            <span>数据概览</span>
          </el-menu-item>

          <div v-if="!isCollapsed" class="menu-group-title">业务管理</div>
          <el-menu-item index="/customers" v-if="canMenu('customers')">
            <el-icon><User /></el-icon>
            <span>客户管理</span>
          </el-menu-item>
          <el-menu-item index="/customer-tags" v-if="canMenu('customer-tags')">
            <el-icon><PriceTag /></el-icon>
            <span>客户标签</span>
          </el-menu-item>
          <el-menu-item index="/customer-pool" v-if="canMenu('customer-pool')">
            <el-icon><List /></el-icon>
            <span>公海客户</span>
          </el-menu-item>
          <el-menu-item index="/opportunities" v-if="canMenu('opportunities')">
            <el-icon><TrendCharts /></el-icon>
            <span>商机管理</span>
          </el-menu-item>
          <el-menu-item index="/contacts" v-if="canMenu('contacts')">
            <el-icon><UserFilled /></el-icon>
            <span>联系人</span>
          </el-menu-item>
          <el-menu-item index="/followups" v-if="canMenu('followups')">
            <el-icon><ChatDotRound /></el-icon>
            <span>跟进管理</span>
          </el-menu-item>
          <div v-if="!isCollapsed" class="menu-group-title">财务</div>
          <el-menu-item index="/contracts" v-if="canMenu('contracts')">
            <el-icon><Document /></el-icon>
            <span>合同管理</span>
          </el-menu-item>
          <el-menu-item index="/payments" v-if="canMenu('payments')">
            <el-icon><Money /></el-icon>
            <span>回款管理</span>
          </el-menu-item>

          <div v-if="!isCollapsed" class="menu-group-title">渠道</div>
          <el-menu-item index="/channels" v-if="canMenu('channels')">
            <el-icon><Connection /></el-icon>
            <span>渠道管理</span>
          </el-menu-item>
          <el-menu-item index="/costs" v-if="canMenu('costs')">
            <el-icon><Wallet /></el-icon>
            <span>成本管理</span>
          </el-menu-item>

          <el-menu-item index="/stats" v-if="canMenu('stats')">
            <el-icon><TrendCharts /></el-icon>
            <span>数据统计</span>
          </el-menu-item>

          <template v-if="canSeeSystemMenu">
            <div v-if="!isCollapsed" class="menu-group-title">系统</div>
            <el-menu-item index="/products" v-if="canMenu('products')">
              <el-icon><Goods /></el-icon>
              <span>产品管理</span>
            </el-menu-item>
            <el-menu-item index="/users" v-if="canMenu('users')">
              <el-icon><Setting /></el-icon>
              <span>用户管理</span>
            </el-menu-item>
            <el-menu-item index="/departments" v-if="canMenu('departments')">
              <el-icon><OfficeBuilding /></el-icon>
              <span>部门管理</span>
            </el-menu-item>
            <el-menu-item index="/settings" v-if="canMenu('settings')">
              <el-icon><Setting /></el-icon>
              <span>配置管理</span>
            </el-menu-item>
            <el-menu-item index="/weekly-meeting" v-if="canMenu('weekly-meeting')">
              <el-icon><Memo /></el-icon>
              <span>开周会</span>
            </el-menu-item>
          </template>
        </el-menu>
      </el-scrollbar>

      <div class="sidebar-footer" @click="isCollapsed = !isCollapsed">
        <el-icon>
          <component :is="isCollapsed ? 'ArrowRight' : 'ArrowLeft'" />
        </el-icon>
        <span v-if="!isCollapsed">收起菜单</span>
      </div>
    </el-aside>

    <el-container class="main-wrapper">
      <el-header class="header">
        <div class="header-left">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/dashboard' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item v-if="route.meta.title">{{ route.meta.title }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <el-dropdown @command="handleCommand" trigger="click">
            <div class="user-info">
              <el-avatar :size="32" class="user-avatar">
                {{ user?.name?.[0] || 'U' }}
              </el-avatar>
              <div class="user-meta">
                <span class="user-name">{{ user?.name || '用户' }}</span>
                <span class="user-role">{{ getRoleLabel(user?.role) }}</span>
              </div>
              <el-icon class="arrow-icon"><ArrowDown /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">
                  <el-icon><User /></el-icon>个人信息
                </el-dropdown-item>
                <el-dropdown-item command="logout" divided>
                  <el-icon><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="main-content">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { Connection, Wallet, Goods, ArrowDown, SwitchButton, Finished } from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()

const isCollapsed = ref(false)
const user = ref(JSON.parse(localStorage.getItem('user') || '{}'))
// 系统菜单组可见角色：管理员 + 运营（运营仅可见组内的产品管理与开周会）+ FDE管理员（仅可见组内的用户管理）
const canSeeSystemMenu = computed(() => ['admin', 'super_admin', 'operations', 'fde_admin'].includes(user.value?.role))
const menuRoles = {
  customers: ['admin', 'super_admin', 'sales', 'presales', 'fde', 'fde_admin', 'operations'],
  'customer-tags': ['admin', 'super_admin', 'sales'],
  // 售前已统一在「商机管理」指派，公海不再按客户级售前过滤，故售前不再展示公海客户菜单（否则恒为空）
  'customer-pool': ['admin', 'super_admin', 'sales', 'fde', 'fde_admin', 'operations'],
  opportunities: ['admin', 'super_admin', 'sales', 'presales', 'fde', 'fde_admin', 'operations'],
  // 售前（presales）、FDE（fde/fde_admin）无权访问联系人模块
  contacts: ['admin', 'super_admin', 'sales', 'operations'],
  followups: ['admin', 'super_admin', 'sales', 'presales', 'fde', 'fde_admin', 'operations'],
  deliveries: [],
  // 售前（presales）、FDE（fde/fde_admin）无权访问合同管理模块
  contracts: ['admin', 'super_admin', 'sales', 'operations'],
  payments: ['admin', 'super_admin', 'sales', 'operations'],
  channels: ['admin', 'super_admin', 'sales', 'operations'],
  costs: ['admin', 'super_admin', 'operations'],
  stats: ['admin', 'super_admin', 'operations', 'fde_admin'],
  // 系统组内菜单：用户管理对管理员和FDE管理员开放（FDE管理员仅能管理FDE角色用户），部门/配置仅管理员可见，产品管理与开周会对运营开放（只读）
  products: ['admin', 'super_admin', 'operations'],
  users: ['admin', 'super_admin', 'fde_admin'],
  departments: ['admin', 'super_admin'],
  settings: ['admin', 'super_admin'],
  'weekly-meeting': ['admin', 'super_admin', 'operations']
}
const canMenu = menu => menuRoles[menu]?.includes(user.value?.role) || false

const activeMenu = computed(() => route.path)

const getRoleLabel = (role) => {
  const map = {
    admin: '管理员',
    super_admin: '超级管理员',
    sales: '销售',
    operations: '运营',
    presales: '售前',
    fde: 'FDE',
    fde_admin: 'FDE管理员'
  }
  return map[role] || '未知'
}

const handleCommand = (command) => {
  if (command === 'profile') {
    router.push('/profile')
  } else if (command === 'logout') {
    ElMessageBox.confirm('确定要退出登录吗？', '退出确认', {
      confirmButtonText: '确定退出',
      cancelButtonText: '取消',
      type: 'warning'
    }).then(() => {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      router.push('/login')
    })
  }
}
</script>

<style scoped>
.layout-container {
  height: 100vh;
}

/* ---------- 侧边栏（飞书浅色风格）---------- */
.sidebar {
  background: var(--color-bg-sidebar);
  display: flex;
  flex-direction: column;
  transition: width var(--transition-normal);
  overflow: hidden;
  border-right: 1px solid var(--color-sidebar-border);
}

.sidebar.collapsed {
  width: 64px !important;
}

/* Logo */
.logo {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 56px;
  padding: 0 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--color-sidebar-border);
  transition: background var(--transition-fast);
}

.logo:hover {
  background: var(--color-bg-sidebar-hover);
}

.logo-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  flex-shrink: 0;
  display: block;
}

.logo-text {
  margin-left: 10px;
  font-size: 17px;
  font-weight: 700;
  color: var(--color-sidebar-text);
  white-space: nowrap;
  letter-spacing: 0.5px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 菜单滚动区 */
.menu-scrollbar {
  flex: 1;
  overflow: hidden;
}

/* 菜单分组标题 */
.menu-group-title {
  padding: 16px 20px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-sidebar-text-secondary);
  letter-spacing: 0.5px;
}

/* 菜单项 */
.el-menu {
  border-right: none;
  padding: 4px 8px;
}

.el-menu-item {
  height: 42px;
  line-height: 42px;
  margin-bottom: 2px;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 400;
  color: var(--color-sidebar-text);
  transition: all var(--transition-fast);
}

.el-menu-item:hover {
  background: var(--color-bg-sidebar-hover) !important;
}

.el-menu-item.is-active {
  background: var(--color-bg-sidebar-active) !important;
  color: var(--color-sidebar-active-text) !important;
  font-weight: 600;
}

/* 选中项：文字黑色加粗，图标用菜单蓝 */
.el-menu-item.is-active .el-icon {
  color: var(--color-sidebar-active-icon);
}

.el-menu-item .el-icon {
  font-size: 18px;
  margin-right: 10px;
}

/* 折叠时的菜单项 */
.sidebar.collapsed .el-menu-item {
  height: 44px;
  line-height: 44px;
  padding: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sidebar.collapsed .el-menu-item .el-icon {
  margin-right: 0;
}

/* 侧边栏底部 */
.sidebar-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  color: var(--color-sidebar-text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-top: 1px solid var(--color-sidebar-border);
  transition: all var(--transition-fast);
  gap: 6px;
}

.sidebar-footer:hover {
  color: var(--color-sidebar-text);
  background: var(--color-bg-sidebar-hover);
}

/* ---------- 主区域 ---------- */
.main-wrapper {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 顶栏 */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 56px;
  background: var(--color-bg-header);
  border-bottom: 1px solid var(--color-border);
  padding: 0 24px;
  box-shadow: var(--shadow-sm);
  z-index: 10;
}

.header-left {
  flex: 1;
}

.header-right {
  display: flex;
  align-items: center;
}

/* 用户信息 */
.user-info {
  display: flex;
  align-items: center;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.user-info:hover {
  background: var(--color-bg-hover);
}

.user-avatar {
  background: var(--color-primary);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
}

.user-meta {
  margin-left: 10px;
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.user-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.user-role {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.arrow-icon {
  margin-left: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

/* 内容区 */
.main-content {
  flex: 1;
  background: var(--color-bg-page);
  padding: 20px;
  overflow-y: auto;
}
</style>
