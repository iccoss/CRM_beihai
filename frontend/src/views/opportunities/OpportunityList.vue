<template>
  <div class="opportunity-list">
    <el-card>
      <div class="filter-bar">
        <el-form :inline="true" :model="filters">
          <el-form-item label="商机名称">
            <el-input v-model="filters.name" placeholder="请输入商机名称" clearable />
          </el-form-item>
          <el-form-item label="客户名称">
            <el-input v-model="filters.customer_name" placeholder="请输入客户名称" clearable />
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="filters.status" placeholder="全部" clearable multiple style="width: 200px">
              <el-option label="潜在" value="potential" />
              <el-option label="技术交流" value="technical" />
              <el-option label="POC" value="poc" />
              <el-option label="立项" value="project" />
              <el-option label="招投标" value="bidding" />
              <el-option label="合同中" value="contracting" />
              <el-option label="已签" value="signed" />
              <el-option label="已丢失" value="lost" />
            </el-select>
          </el-form-item>
          <!-- 意向产品筛选：选项取自商机表实际数据，可覆盖已改名/停用的历史产品 -->
          <el-form-item label="意向产品">
            <el-select
              v-model="filters.products"
              placeholder="全部"
              clearable
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              style="width: 200px"
            >
              <el-option v-for="item in productOptions" :key="item" :label="item" :value="item" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="loadData">查询</el-button>
            <el-button @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="toolbar">
        <el-button type="primary" @click="showAddDialog" v-if="canManageOpportunity">
          <el-icon><Plus /></el-icon>
          新增商机
        </el-button>
        <el-button :loading="exporting" @click="exportOpportunities">
          <el-icon><Download /></el-icon>
          导出商机
        </el-button>
      </div>

      <el-table
        :data="tableData"
        v-loading="loading"
        style="width: 100%"
      >
        <el-table-column prop="name" label="商机名称" min-width="180" />
        <el-table-column prop="customer_name" label="关联客户" min-width="150" />
        <el-table-column prop="type" label="商机类型" width="100">
          <template #default="{ row }">
            <el-tag :type="getTypeType(row.type)" size="small">
              {{ getTypeLabel(row.type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="amount" label="商机金额(元)" width="180" align="right" v-if="!isTechnicalUser">
          <template #default="{ row }">
            <span style="color: #34c724; font-weight: bold; white-space: nowrap;">
              {{ formatLargeNumber(row.amount) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)" size="small">
              {{ getStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="products" label="意向产品" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.products || '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="creator_name" label="销售" width="100" />
        <el-table-column label="售前" width="120">
          <template #default="{ row }">
            <span class="assignment-name">{{ row.presales_names || '未指派' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="FDE" width="120">
          <template #default="{ row }">
            <span class="assignment-name">{{ row.fde_names || '未指派' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="share_percent" label="分成比例" width="100" align="right" v-if="!isTechnicalUser">
          <template #default="{ row }">
            {{ row.share_percent }}%
          </template>
        </el-table-column>
        <el-table-column prop="followup_count" label="跟进次数" width="100" align="center">
          <template #default="{ row }">
            <span :style="row.followup_count > 0 ? 'color: #34c724; font-weight: bold;' : 'color: #8f959e;'">{{ row.followup_count || 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(cmd) => handleCommand(cmd, row)" :popper-options="{ modifiers: [{ name: 'computeStyles', options: { adaptive: false } }], strategy: 'fixed' }" popper-class="opportunity-dropdown">
              <el-button text type="primary" @click.stop>
                更多<el-icon><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="detail">详情</el-dropdown-item>
                  <el-dropdown-item command="edit" v-if="canManageOpportunity">编辑</el-dropdown-item>
                  <!-- 商机级指派快捷入口：直接打开指派弹窗，作用于当前行的商机 -->
                  <el-dropdown-item command="assign-presales" v-if="canAssignPresales">设置售前</el-dropdown-item>
                  <el-dropdown-item command="assign-fde" v-if="canAssignFdeRow(row)">设置FDE</el-dropdown-item>
                  <el-dropdown-item command="delete" divided v-if="canManageOpportunity">删除</el-dropdown-item>
                  <el-dropdown-item command="followup">新增跟进</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>

      <div class="summary-bar" v-if="!isTechnicalUser">
        <span class="summary-label">商机金额合计：</span>
        <span class="summary-value" style="white-space: nowrap;">¥{{ (totalAmount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}元</span>
      </div>

      <div class="pagination">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.limit"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="loadData"
          @current-change="loadData"
        />
      </div>
    </el-card>

    <!-- 新增/编辑商机对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑商机' : '新增商机'"
      width="900px"
      :close-on-click-modal="false"
    >
      <el-form :model="opportunityForm" :rules="rules" ref="formRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="商机名称" prop="name">
              <el-input v-model="opportunityForm.name" placeholder="请输入商机名称（必填）" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="关联客户" prop="customer_id">
              <el-select
                v-model="opportunityForm.customer_id"
                placeholder="请选择客户（必填）"
                style="width: 100%"
                filterable
                @change="onCustomerChange"
              >
                <el-option
                  v-for="customer in customerList"
                  :key="customer.id"
                  :label="customer.name"
                  :value="customer.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户联系人" prop="contact_id">
              <el-select
                v-model="opportunityForm.contact_id"
                placeholder="请选择联系人（必填）"
                style="width: 100%"
                :disabled="!opportunityForm.customer_id"
                filterable
              >
                <el-option
                  v-for="contact in contactList"
                  :key="contact.id"
                  :label="contact.name"
                  :value="contact.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label=" ">
              <el-button 
                type="primary" 
                :disabled="!opportunityForm.customer_id"
                @click="showCreateContactDialog"
              >
                <el-icon><Plus /></el-icon>
                创建联系人
              </el-button>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="商机类型" prop="type">
              <el-select v-model="opportunityForm.type" placeholder="请选择类型（必填）" style="width: 100%">
                <el-option label="新项目" value="new_project" />
                <el-option label="续签" value="renewal" />
                <el-option label="维保" value="maintenance" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="需求描述">
              <el-input
                v-model="opportunityForm.description"
                type="textarea"
                :rows="3"
                placeholder="请输入需求描述"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="意向产品" prop="products">
              <el-select
                v-model="opportunityForm.products"
                placeholder="请选择意向产品（必填）"
                style="width: 100%"
              >
                <el-option
                  v-for="p in productList"
                  :key="p.id"
                  :label="p.name"
                  :value="p.name"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="预计签约时间" prop="expected_sign_date">
              <el-date-picker
                v-model="opportunityForm.expected_sign_date"
                type="date"
                placeholder="请选择日期（必填）"
                style="width: 100%"
                value-format="YYYY-MM-DD"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="竞争对手">
              <el-input v-model="opportunityForm.competitors" placeholder="请输入竞争对手" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商机金额" prop="amount">
              <el-input-number
                v-model="opportunityForm.amount"
                :min="0"
                :precision="2"
                :step="1000"
                style="width: 100%"
                placeholder="请输入金额（必填）"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="渠道分成比例">
              <div style="display:flex;align-items:center;gap:8px;width:100%">
                <el-input-number
                  v-model="opportunityForm.channel_commission_rate"
                  :min="0"
                  :max="100"
                  :precision="1"
                  :step="0.5"
                  style="flex:1;min-width:0"
                  placeholder="无渠道"
                />
                <span style="white-space:nowrap;font-size:14px">%</span>
              </div>
              <div v-if="opportunityForm.channel_name" style="font-size:12px;color:#8f959e;margin-top:4px">
                关联渠道：{{ opportunityForm.channel_name }}
              </div>
              <div v-else-if="opportunityForm.customer_id" style="font-size:12px;color:#bbbfc4;margin-top:4px">
                该客户未关联渠道
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="负责销售" prop="owner_id">
              <el-select
                v-model="opportunityForm.owner_id"
                :placeholder="currentUser.role === 'sales' ? '当前登录销售' : '请选择负责销售（必填）'"
                style="width: 100%"
                :disabled="currentUser.role === 'sales'"
              >
                <el-option v-for="sales in salesList" :key="sales.id" :label="sales.name" :value="sales.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商机状态">
              <el-select v-model="opportunityForm.status" placeholder="请选择状态" style="width: 100%">
                <el-option label="潜在" value="potential" />
                <el-option label="技术交流" value="technical" />
                <el-option label="POC" value="poc" />
                <el-option label="立项" value="project" />
                <el-option label="招投标" value="bidding" />
                <el-option label="合同中" value="contracting" />
                <el-option label="已签" value="signed" />
                <el-option label="已丢失" value="lost" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="商机级售前">
              <el-select v-model="opportunityForm.presales_user_id" clearable filterable placeholder="暂不指派" style="width: 100%">
                <el-option v-for="user in presalesList" :key="user.id" :label="user.name" :value="user.id" />
              </el-select>
              <div class="presales-field-hint">
                {{ opportunityForm.presales_user_id ? '商机级指派可独立修改，不影响客户级默认售前' : '本商机暂不指派售前' }}
              </div>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm" :loading="submitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 商机详情对话框 -->
    <el-dialog
      v-model="detailVisible"
      title="商机详情"
      width="900px"
    >
      <el-descriptions :column="2" border v-if="detailData.opportunity">
        <el-descriptions-item label="商机名称">{{ detailData.opportunity.name }}</el-descriptions-item>
        <el-descriptions-item label="关联客户">{{ detailData.opportunity.customer_name }}</el-descriptions-item>
        <el-descriptions-item label="客户联系人">{{ detailData.opportunity.contact_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="商机类型">{{ getTypeLabel(detailData.opportunity.type) }}</el-descriptions-item>
        <el-descriptions-item label="需求描述" :span="2">{{ detailData.opportunity.description || '-' }}</el-descriptions-item>
        <el-descriptions-item label="意向产品">{{ detailData.opportunity.products || '-' }}</el-descriptions-item>
        <el-descriptions-item label="预计签约时间">{{ detailData.opportunity.expected_sign_date || '-' }}</el-descriptions-item>
        <el-descriptions-item label="竞争对手">{{ detailData.opportunity.competitors || '-' }}</el-descriptions-item>
        <el-descriptions-item label="商机金额(元)">
          <span v-if="detailData.opportunity.commercial_hidden">-</span>
          <span v-else style="color: #34c724; font-weight: bold; white-space: nowrap;">
            {{ formatLargeNumber(detailData.opportunity.amount) }}
          </span>
        </el-descriptions-item>
        <el-descriptions-item label="销售">{{ detailData.opportunity.owner_name }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="getStatusType(detailData.opportunity.status)" size="small">
            {{ getStatusLabel(detailData.opportunity.status) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="渠道名称">
          {{ detailData.opportunity.customer_channel_id ? (detailData.opportunity.channel_name || '-') : '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="渠道分成比例" v-if="!detailData.opportunity.commercial_hidden">
          <template v-if="detailData.opportunity.customer_channel_id">
            <span style="font-weight:bold;color:#34c724">
              {{ (detailData.opportunity.channel_commission_rate !== null && detailData.opportunity.channel_commission_rate !== undefined) ? detailData.opportunity.channel_commission_rate + '%' : (detailData.opportunity.channel_default_commission_rate + '%') }}
            </span>
          </template>
          <span v-else>-</span>
        </el-descriptions-item>
        <el-descriptions-item label="创建人">{{ detailData.opportunity.creator_name }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ detailData.opportunity.created_at }}</el-descriptions-item>
      </el-descriptions>

      <el-divider content-position="left">技术协作</el-divider>
      <div class="assignment-panel" v-if="detailData.opportunity">
        <div class="assignment-card">
          <div class="assignment-meta">
            <span class="assignment-label">售前跟进</span>
            <div class="assignment-fde-list" v-if="presalesAssignments.length > 0">
              <el-tag
                v-for="item in presalesAssignments"
                :key="`${item.source}-${item.user_id}`"
                size="small"
                type="success"
                effect="plain"
                :closable="canAssignPresales && item.source === 'opportunity' && !!item.id"
                @close="removeAssignment(item)"
              >
                {{ item.user_name || item.name }}
              </el-tag>
            </div>
            <strong v-else>未指派</strong>
          </div>
          <el-button
            v-if="canAssignPresales"
            class="assignment-action"
            type="primary"
            plain
            @click="openAssignment('presales')"
          >
            {{ presalesAssignments.length > 0 ? '更换售前' : '指派售前' }}
          </el-button>
        </div>
        <div class="assignment-card">
          <div class="assignment-meta">
            <span class="assignment-label">FDE跟进</span>
            <div class="assignment-fde-list" v-if="fdeAssignments.length > 0">
              <el-tag
                v-for="item in fdeAssignments"
                :key="`${item.source}-${item.user_id}`"
                size="small"
                type="warning"
                effect="plain"
                :closable="canAssignFde && item.source === 'opportunity' && !!item.id"
                @close="removeAssignment(item)"
              >
                {{ item.user_name || item.name }}
                <span v-if="item.source === 'customer'" class="assignment-source">客户级</span>
              </el-tag>
            </div>
            <strong v-else>未指派</strong>
          </div>
          <el-tooltip
            v-if="canAssignFde"
            :disabled="canAssignFdeNow"
            content="商机进入技术交流后才可指派FDE"
            placement="top"
          >
            <span class="assignment-action-wrap">
              <el-button
                class="assignment-action"
                type="primary"
                plain
                :disabled="!canAssignFdeNow"
                @click="openAssignment('fde')"
              >
                指派FDE
              </el-button>
            </span>
          </el-tooltip>
        </div>
      </div>

      <el-divider content-position="left">跟进记录</el-divider>
      <el-table :data="detailData.followups" style="width: 100%" size="small" max-height="300" v-if="detailData.followups && detailData.followups.length > 0">
        <el-table-column label="序号" width="60" align="center">
          <template #default="{ $index }">
            <el-tag size="small" type="primary">{{ $index + 1 }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="followup_time_formatted" label="时间" width="180" />
        <el-table-column prop="type" label="方式" width="80">
          <template #default="{ row }">
            <el-tag size="small">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="content" label="内容" min-width="200">
          <template #default="{ row }">
            <div class="followup-content-cell">{{ row.content }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="user_name" label="跟进人" width="130">
          <template #default="{ row }">
            {{ row.user_name }}
            <el-tag v-if="row.user_role" size="small" :type="row.user_role === 'sales' ? '' : row.user_role === 'presales' ? 'success' : row.user_role === 'fde' ? 'warning' : row.user_role === 'fde_admin' ? 'danger' : 'info'" style="margin-left: 4px;">
              {{ { sales: '销售', presales: '售前', fde: 'FDE', fde_admin: 'FDE管理员', admin: '管理员', super_admin: '超管', operations: '运营', after_sales: '售后' }[row.user_role] || row.user_role }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="暂无跟进记录" :image-size="80" />
    </el-dialog>

    <el-dialog
      v-model="assignmentVisible"
      :title="assignmentDialogTitle"
      width="500px"
    >
      <el-form :model="assignmentForm" label-width="90px">
        <!-- 从列表"更多"下拉进入时，展示当前操作的商机名称，避免误指派 -->
        <el-form-item label="商机" v-if="assignmentEntry === 'row'">
          <span>{{ assignmentTarget.name || '-' }}</span>
        </el-form-item>
        <el-form-item label="角色">
          <el-tag>{{ assignmentForm.assignment_type === 'fde' ? 'FDE' : '售前' }}</el-tag>
        </el-form-item>
        <el-form-item label="人员">
          <!-- FDE 支持多选且人数不限；售前保持原有单选覆盖逻辑 -->
          <el-select
            v-if="assignmentForm.assignment_type === 'fde'"
            v-model="assignmentForm.user_ids"
            placeholder="请选择FDE人员（可多选）"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            style="width: 100%"
          >
            <el-option v-for="user in assignmentUsers" :key="user.id" :label="user.name" :value="user.id" />
          </el-select>
          <el-select
            v-else
            v-model="assignmentForm.user_id"
            placeholder="请选择人员"
            filterable
            style="width: 100%"
          >
            <el-option v-for="user in assignmentUsers" :key="user.id" :label="user.name" :value="user.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="assignmentForm.remark" type="textarea" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assignmentVisible = false">取消</el-button>
        <el-button type="primary" :loading="assignmentSubmitting" @click="submitAssignment">确定</el-button>
      </template>
    </el-dialog>

    <!-- 创建联系人对话框 -->
    <el-dialog
      v-model="contactDialogVisible"
      title="创建联系人"
      width="500px"
    >
      <el-form :model="contactForm" :rules="contactRules" ref="contactFormRef" label-width="100px">
        <el-form-item label="姓名" prop="name">
          <el-input v-model="contactForm.name" placeholder="请输入联系人姓名（必填）" />
        </el-form-item>
        <el-form-item label="职位" prop="position">
          <el-input v-model="contactForm.position" placeholder="请输入职位" />
        </el-form-item>
        <el-form-item label="手机" prop="phone">
          <el-input v-model="contactForm.phone" placeholder="请输入手机号码（必填）" maxlength="11" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="contactForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="是否 KP">
          <el-switch v-model="contactForm.is_kp" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="contactDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitContact" :loading="contactSubmitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 新增跟进对话框 -->
    <el-dialog
      v-model="followupDialogVisible"
      title="新增跟进"
      width="800px"
      :close-on-click-modal="false"
    >
      <el-form :model="followupForm" :rules="followupRules" ref="followupFormRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户">
              <el-input v-model="followupForm.customer_name" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="关联商机">
              <el-input v-model="followupForm.opportunity_name" disabled />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="跟进方式" prop="type">
              <el-select v-model="followupForm.type" placeholder="请选择跟进方式" style="width: 100%">
                <el-option label="电话" value="电话" />
                <el-option label="微信" value="微信" />
                <el-option label="邮箱" value="邮箱" />
                <el-option label="拜访" value="拜访" />
                <el-option label="会议" value="会议" />
                <el-option label="其他" value="其他" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="跟进阶段">
              <el-select v-model="followupForm.stage" placeholder="请选择阶段" style="width: 100%"
                :disabled="followupForm.stage === 'signed'"
              >
                <el-option label="潜在" value="potential" />
                <el-option label="技术交流" value="technical" />
                <el-option label="POC" value="poc" />
                <el-option label="立项" value="project" />
                <el-option label="招投标" value="bidding" />
                <el-option label="合同中" value="contracting" />
                <el-option label="已签" value="signed" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="跟进内容" prop="content">
              <el-input
                v-model="followupForm.content"
                type="textarea"
                :rows="4"
                placeholder="请详细记录跟进过程（至少 10 个字）"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="跟进结果">
              <el-select v-model="followupForm.result" placeholder="请选择结果" style="width: 100%">
                <el-option label="未达成" value="未达成" />
                <el-option label="达成部分" value="达成部分" />
                <el-option label="完全达成" value="完全达成" />
                <el-option label="客户拒绝" value="客户拒绝" />
                <el-option label="客户失联" value="客户失联" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="followupDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitFollowup" :loading="followupSubmitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 新增合同对话框（商机状态变更为已签时弹出） -->
    <el-dialog
      v-model="contractDialogVisible"
      title="新增合同"
      width="900px"
      :close-on-click-modal="false"
    >
      <el-alert
        title="商机状态为已签，请先创建合同后再完成商机编辑"
        type="info"
        :closable="false"
        style="margin-bottom: 15px"
      />
      <el-form :model="contractForm" :rules="contractRules" ref="contractFormRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户" prop="customer_id">
              <el-select
                v-model="contractForm.customer_id"
                placeholder="请选择客户"
                filterable
                style="width: 100%"
                @change="handleContractCustomerChange"
              >
                <el-option
                  v-for="customer in customerListForContract"
                  :key="customer.id"
                  :label="customer.name"
                  :value="customer.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="关联商机" prop="opportunity_id">
              <el-select
                v-model="contractForm.opportunity_id"
                placeholder="请选择关联商机(必填)"
                filterable
                style="width: 100%"
                :disabled="!contractForm.customer_id"
              >
                <el-option
                  v-for="opp in opportunityListForContract"
                  :key="opp.id"
                  :label="opp.name"
                  :value="opp.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="联系人">
              <el-select
                v-model="contractForm.contact_id"
                placeholder="请选择联系人"
                filterable
                clearable
                style="width: 100%"
                :disabled="!contractForm.customer_id"
              >
                <el-option
                  v-for="contact in contactListForContract"
                  :key="contact.id"
                  :label="contact.name + (contact.position ? ' (' + contact.position + ')' : '')"
                  :value="contact.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="合同名称" prop="title">
              <el-input v-model="contractForm.title" placeholder="请输入合同名称" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="付款方式" prop="payment_method">
              <el-select v-model="contractForm.payment_method" placeholder="请选择付款方式" style="width: 100%">
                <el-option label="按月" value="monthly" />
                <el-option label="按季度" value="quarterly" />
                <el-option label="按年" value="yearly" />
                <el-option label="按次" value="per_time" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="付款次数" prop="payment_times">
              <el-input-number
                v-model="contractForm.payment_times"
                :min="1"
                :max="4"
                :disabled="contractForm.payment_method !== 'per_time'"
                style="width: 100%"
                placeholder="按次付款时填写次数(最多 4 次)"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="付款条款">
              <el-input
                v-model="contractForm.payment_terms"
                type="textarea"
                :rows="3"
                placeholder="请输入付款条款,例如:首付款 30%,验收后 70%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="合同内容">
              <el-input
                v-model="contractForm.content"
                type="textarea"
                :rows="5"
                placeholder="请输入合同详细内容"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="合同类型" prop="type">
              <el-select v-model="contractForm.type" placeholder="请选择合同类型" style="width: 100%">
                <el-option label="销售合同" value="销售合同" />
                <el-option label="采购合同" value="采购合同" />
                <el-option label="服务合同" value="服务合同" />
                <el-option label="其他" value="其他" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="合同状态">
              <el-select v-model="contractForm.status" placeholder="请选择状态" style="width: 100%">
                <el-option label="执行中" value="active" />
                <el-option label="已完成" value="completed" />
                <el-option label="已终止" value="terminated" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="合同金额" prop="amount">
              <el-input-number
                v-model="contractForm.amount"
                :min="0"
                :precision="2"
                :step="1000"
                style="width: 100%"
                placeholder="请输入合同金额"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="签订日期" prop="sign_date">
              <el-date-picker
                v-model="contractForm.sign_date"
                type="date"
                placeholder="选择签订日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="生效日期" prop="effective_date">
              <el-date-picker
                v-model="contractForm.effective_date"
                type="date"
                placeholder="选择生效日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="到期日期" prop="expire_date">
              <el-date-picker
                v-model="contractForm.expire_date"
                type="date"
                placeholder="选择到期日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 付款计划 -->
        <el-divider>付款计划</el-divider>
        <el-alert
          title="付款计划为必填项，根据付款方式自动生成付款计划"
          type="warning"
          :closable="false"
          style="margin-bottom: 15px"
        />
        <div v-if="contractForm.payment_method" style="margin-bottom: 15px">
          <el-button type="primary" size="small" @click="generateContractPaymentPlans">
            生成付款计划
          </el-button>
        </div>
        <div v-if="contractForm.payment_plans && contractForm.payment_plans.length > 0">
          <div v-for="(plan, index) in contractForm.payment_plans" :key="index" style="margin-bottom: 15px; padding: 15px; border: 1px solid #dee0e3; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span style="font-weight: bold; color: #3370ff;">第{{ index + 1 }}期付款</span>
              <el-button type="danger" size="small" @click="removeContractPaymentPlan(index)">删除</el-button>
            </div>
            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="付款金额" :rules="[{ required: true, message: '请输入金额', trigger: 'blur' }]">
                  <el-input-number
                    v-model="plan.amount"
                    :min="0"
                    :precision="2"
                    style="width: 100%"
                    placeholder="请输入付款金额"
                  />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="付款日期" :rules="[{ required: true, message: '请选择日期', trigger: 'change' }]">
                  <el-date-picker
                    v-model="plan.date"
                    type="date"
                    placeholder="选择付款日期"
                    style="width: 100%"
                  />
                </el-form-item>
              </el-col>
            </el-row>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="contractDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="contractSubmitting" @click="submitContractFromOpportunity">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'
import { downloadBlobResponse } from '@/utils/download'

const router = useRouter()
const route = useRoute()
const loading = ref(false)
const exporting = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const detailVisible = ref(false)
const isEdit = ref(false)
const formRef = ref(null)
const contactDialogVisible = ref(false)
const contactSubmitting = ref(false)
const contactFormRef = ref(null)
const followupDialogVisible = ref(false)
const followupSubmitting = ref(false)
const followupFormRef = ref(null)
const assignmentVisible = ref(false)
const assignmentSubmitting = ref(false)
const assignmentUsers = ref([])
const assignmentForm = reactive({ assignment_type: 'presales', user_id: '', user_ids: [], remark: '' })
// 指派弹窗的目标商机（详情页入口与列表"更多"下拉入口共用）
const assignmentTarget = ref({ id: '', name: '', status: '', owner_id: '', assignments: [] })
// 弹窗入口来源：detail=详情页入口，row=列表"更多"下拉入口（用于区分标题与商机行展示）
const assignmentEntry = ref('detail')

// 合同创建对话框相关状态
const contractDialogVisible = ref(false)
const contractSubmitting = ref(false)
const contractFormRef = ref(null)
const contractForm = reactive({
  id: '', customer_id: '', contact_id: '', opportunity_id: '', title: '', type: '',
  amount: 0, status: 'active', sign_date: '', effective_date: '',
  expire_date: '', payment_method: '', payment_times: 1,
  payment_plans: [],
  content: '', payment_terms: ''
})
const customerListForContract = ref([])
const contactListForContract = ref([])
const opportunityListForContract = ref([])
const productList = ref([])
// 意向产品筛选下拉选项（来自商机表实际数据，与表单用的 productList 相互独立）
const productOptions = ref([])

const contractRules = {
  customer_id: [{ required: true, message: '请选择客户', trigger: 'change' }],
  opportunity_id: [{ required: true, message: '请选择关联商机', trigger: 'change' }],
  title: [{ required: true, message: '请输入合同名称', trigger: 'blur' }],
  amount: [{ required: true, message: '请输入合同金额', trigger: 'blur' }],
  sign_date: [{ required: true, message: '请选择签订日期', trigger: 'change' }],
  effective_date: [{ required: true, message: '请选择生效日期', trigger: 'change' }],
  expire_date: [{ required: true, message: '请选择到期日期', trigger: 'change' }],
  payment_method: [{ required: true, message: '请选择付款方式', trigger: 'change' }]
}

// 保存状态切换前的表单数据
let pendingOpportunitySubmit = false
let savedOpportunityForm = null

const filters = reactive({
  name: '',
  customer_name: '',
  status: [],
  products: []
})
const totalAmount = ref(0)

const tableData = ref([])
const customerList = ref([])
const contactList = ref([])
const salesList = ref([])
const presalesList = ref([])
const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
const isTechnicalUser = ['presales', 'fde', 'fde_admin'].includes(currentUser.role)
const canManageOpportunity = ['sales', 'admin', 'super_admin'].includes(currentUser.role)
const canAssignPresales = ['sales', 'admin', 'super_admin'].includes(currentUser.role)
const isSystemAdminUser = ['admin', 'super_admin'].includes(currentUser.role)

const detailData = reactive({
  opportunity: null,
  followups: [],
  assignments: []
})

// 可指派FDE的商机状态（与后端保持一致：进入技术交流及之后的阶段）
const fdeAssignableStatuses = ['technical', 'poc', 'project', 'bidding', 'contracting', 'signed']

// FDE指派权限：系统管理员、FDE管理员可操作全部商机；销售仅能操作自己负责的商机
// 行级判断（列表"更多"下拉使用）：传入商机行数据即可判断
const canAssignFdeRow = (row) => {
  if (isSystemAdminUser || currentUser.role === 'fde_admin') return true
  if (currentUser.role !== 'sales') return false
  return !!row && row.owner_id === currentUser.id
}

// 详情页判断：沿用原有逻辑，基于当前详情弹窗中的商机
const canAssignFde = computed(() => canAssignFdeRow(detailData.opportunity))

// 当前商机状态是否已满足指派FDE的条件
const canAssignFdeNow = computed(() =>
  canAssignFde.value && fdeAssignableStatuses.includes(detailData.opportunity?.status)
)

// 详情页FDE指派列表（含商机级与客户级两种来源）
const fdeAssignments = computed(() =>
  (detailData.assignments || []).filter(item => item.assignment_type === 'fde')
)

// 详情页售前指派列表（售前已统一在商机维度指派，来源均为商机级）
const presalesAssignments = computed(() =>
  (detailData.assignments || []).filter(item => item.assignment_type === 'presales')
)

const pagination = reactive({
  page: 1,
  limit: 10,
  total: 0
})

const opportunityForm = reactive({
  id: '',
  name: '',
  customer_id: '',
  contact_id: '',
  type: '',
  description: '',
  products: '',
  expected_sign_date: '',
  competitors: '',
  amount: 0,
  owner_id: '',
  presales_user_id: '',
  status: 'potential',
  channel_commission_rate: null,
  channel_name: ''
})

const contactForm = reactive({
  customer_id: '',
  name: '',
  position: '',
  phone: '',
  email: '',
  is_kp: false
})

const contactRules = {
  name: [
    { required: true, message: '请输入联系人姓名', trigger: 'blur' }
  ],
  phone: [
    { required: true, message: '请输入手机号码', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号格式', trigger: 'blur' }
  ]
}

const followupForm = reactive({
  customer_id: '',
  customer_name: '',
  opportunity_id: '',
  opportunity_name: '',
  type: '',
  content: '',
  stage: '',
  result: ''
})

const followupRules = {
  type: [{ required: true, message: '请选择跟进方式', trigger: 'change' }],
  content: [
    { required: true, message: '请输入跟进内容', trigger: 'blur' },
    { min: 10, message: '跟进内容至少 10 个字', trigger: 'blur' }
  ]
}

const rules = {
  name: [
    { required: true, message: '请输入商机名称', trigger: 'blur' }
  ],
  customer_id: [
    { required: true, message: '请选择关联客户', trigger: 'change' }
  ],
  owner_id: [
    { required: true, message: '请选择负责销售', trigger: 'change' }
  ],
  contact_id: [
    { required: true, message: '请选择客户联系人', trigger: 'change' }
  ],
  type: [
    { required: true, message: '请选择商机类型', trigger: 'change' }
  ],
  products: [
    { required: true, message: '请选择意向产品', trigger: 'change' }
  ],
  expected_sign_date: [
    { required: true, message: '请选择预计签约时间', trigger: 'change' }
  ],
  amount: [
    { required: true, message: '请输入商机金额', trigger: 'blur' }
  ]
}

const getTypeType = (type) => {
  const map = {
    new_project: 'primary',
    renewal: 'success',
    maintenance: 'warning'
  }
  return map[type] || ''
}

const getTypeLabel = (type) => {
  const map = {
    new_project: '新项目',
    renewal: '续签',
    maintenance: '维保'
  }
  return map[type] || type
}

const getStatusType = (status) => {
  const map = {
    potential: 'info',
    technical: 'warning',
    poc: 'warning',
    project: 'primary',
    bidding: 'primary',
    contracting: 'success',
    signed: 'success',
    lost: 'danger'
  }
  return map[status] || ''
}

const getStatusLabel = (status) => {
  const map = {
    potential: '潜在',
    technical: '技术交流',
    poc: 'POC',
    project: '立项',
    bidding: '招投标',
    contracting: '合同中',
    signed: '已签',
    lost: '已丢失'
  }
  return map[status] || status
}

// 格式化大数字，直接显示完整数值
const formatLargeNumber = (num) => {
  num = num || 0
  // 直接显示完整数值，使用千分位分隔符
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

const disabledDate = (time) => {
  return time.getTime() < Date.now() - 86400000
}

const loadData = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/opportunities', {
      params: {
        page: pagination.page,
        limit: pagination.limit,
        name: filters.name || undefined,
        customer_name: filters.customer_name || undefined,
        status: filters.status && filters.status.length > 0 ? filters.status.join(',') : undefined,
        products: filters.products && filters.products.length > 0 ? filters.products.join(',') : undefined
      }
    })
    tableData.value = data.data
    pagination.total = data.pagination.total
    totalAmount.value = data.totalAmount || 0
  } catch (error) {
    ElMessage.error('加载商机列表失败')
  } finally {
    loading.value = false
  }
}

const resetFilters = () => {
  filters.name = ''
  filters.customer_name = ''
  filters.status = []
  filters.products = []
  pagination.page = 1
  loadData()
}

const exportOpportunities = async () => {
  exporting.value = true
  try {
    const response = await request.get('/api/opportunities/export', {
      params: {
        name: filters.name || undefined,
        customer_name: filters.customer_name || undefined,
        status: filters.status?.length ? filters.status.join(',') : undefined,
        products: filters.products?.length ? filters.products.join(',') : undefined
      },
      responseType: 'blob'
    })
    downloadBlobResponse(response, `商机数据_${new Date().toISOString().slice(0, 10)}.csv`)
    ElMessage.success('商机数据导出成功')
  } catch (error) {
    ElMessage.error('商机数据导出失败')
  } finally {
    exporting.value = false
  }
}

const loadCustomers = async () => {
  try {
    const { data } = await request.get('/api/customers', { params: { limit: 100 } })
    customerList.value = data.data || []
  } catch (error) {
    // 忽略错误
  }
}

const loadProducts = async () => {
  try {
    const { data } = await request.get('/api/products/all')
    productList.value = data.data || []
  } catch (error) {
    // 忽略错误
  }
}

// 加载「意向产品」筛选下拉选项：取自商机表实际出现过的产品名，可覆盖已改名/停用的历史产品
const loadProductOptions = async () => {
  try {
    const { data } = await request.get('/api/opportunities/product-options')
    productOptions.value = data.data || []
  } catch (error) {
    // 忽略错误
  }
}

const loadContacts = async (customerId) => {
  try {
    const { data } = await request.get(`/api/opportunities/customers/${customerId}/contacts`)
    contactList.value = data.contacts || []
  } catch (error) {
    contactList.value = []
  }
}

const loadSales = async () => {
  try {
    const { data } = await request.get('/api/users', { params: { limit: 100, role: 'sales', status: 'active' } })
    salesList.value = data.data || []
    if (currentUser.role === 'sales' && currentUser.id && !salesList.value.some(user => user.id === currentUser.id)) {
      salesList.value.unshift({
        id: currentUser.id,
        name: currentUser.name || currentUser.username,
        username: currentUser.username,
        role: 'sales'
      })
    }
  } catch (error) {
    if (currentUser.role === 'sales' && currentUser.id) {
      salesList.value = [{
        id: currentUser.id,
        name: currentUser.name || currentUser.username,
        username: currentUser.username,
        role: 'sales'
      }]
    }
  }
}

const loadPresales = async () => {
  try {
    const { data } = await request.get('/api/users', { params: { limit: 100, role: 'presales', status: 'active' } })
    presalesList.value = data.data || []
  } catch (error) {
    presalesList.value = []
  }
}

const onCustomerChange = async (customerId) => {
  if (customerId) {
    const customer = customerList.value.find(item => item.id === customerId)
    opportunityForm.presales_user_id = customer?.default_presales_id || ''
    loadContacts(customerId)
    opportunityForm.contact_id = ''
    // 加载渠道信息
    try {
      const { data } = await request.get(`/api/opportunities/customers/${customerId}/channel-info`)
      if (data && data.channel_id) {
        opportunityForm.channel_commission_rate = data.commission_rate
        opportunityForm.channel_name = data.channel_name
      } else {
        opportunityForm.channel_commission_rate = null
        opportunityForm.channel_name = ''
      }
    } catch (e) {
      opportunityForm.channel_commission_rate = null
      opportunityForm.channel_name = ''
    }
  } else {
    contactList.value = []
    opportunityForm.presales_user_id = ''
    opportunityForm.channel_commission_rate = null
    opportunityForm.channel_name = ''
  }
}

// 显示创建联系人对话框
const showCreateContactDialog = () => {
  if (!opportunityForm.customer_id) {
    ElMessage.warning('请先选择客户')
    return
  }
  Object.assign(contactForm, {
    customer_id: opportunityForm.customer_id,
    name: '',
    position: '',
    phone: '',
    email: '',
    is_kp: false
  })
  contactDialogVisible.value = true
}

// 提交联系人
const submitContact = async () => {
  if (!contactFormRef.value) return
  
  await contactFormRef.value.validate(async (valid) => {
    if (!valid) return
    
    contactSubmitting.value = true
    try {
      await request.post('/api/contacts', contactForm)
      ElMessage.success('联系人创建成功')
      contactDialogVisible.value = false
      // 重新加载联系人列表
      loadContacts(opportunityForm.customer_id)
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '创建失败')
    } finally {
      contactSubmitting.value = false
    }
  })
}

const showAddDialog = () => {
  isEdit.value = false
  Object.assign(opportunityForm, {
    id: '',
    name: '',
    customer_id: '',
    contact_id: '',
    type: '',
    description: '',
    products: '',
    expected_sign_date: '',
    competitors: '',
    amount: 0,
    owner_id: currentUser.role === 'sales' ? currentUser.id : '',
    presales_user_id: '',
    status: 'potential',
    channel_commission_rate: null,
    channel_name: ''
  })
  contactList.value = []
  dialogVisible.value = true
}

const editOpportunity = async (row) => {
  isEdit.value = true
  Object.assign(opportunityForm, {
    id: row.id,
    name: row.name,
    customer_id: row.customer_id,
    contact_id: row.contact_id,
    type: row.type,
    description: row.description || '',
    products: row.products || '',
    expected_sign_date: row.expected_sign_date,
    competitors: row.competitors || '',
    amount: row.amount,
    owner_id: row.owner_id,
    presales_user_id: '',
    status: row.status,
    channel_commission_rate: row.channel_commission_rate || null,
    channel_name: ''
  })
  
  // 加载该客户的联系人
  if (row.customer_id) {
    loadContacts(row.customer_id)
    try {
      const { data } = await request.get(`/api/opportunities/${row.id}/assignments`)
      // 编辑弹窗仅回填商机级指派，客户级指派不参与表单回填，避免保存时产生意外的商机级指派
      const presalesAssignment = (data.data || []).find(item => item.assignment_type === 'presales' && item.status === 'active' && item.source !== 'customer')
      opportunityForm.presales_user_id = presalesAssignment?.user_id || ''
    } catch (error) {
      opportunityForm.presales_user_id = ''
    }
    // 加载渠道信息
    try {
      const { data } = await request.get(`/api/opportunities/customers/${row.customer_id}/channel-info`)
      if (data && data.channel_id) {
        opportunityForm.channel_name = data.channel_name
        // 如果原商机没有设置 channel_commission_rate，用渠道默认值填充
        if (!opportunityForm.channel_commission_rate) {
          opportunityForm.channel_commission_rate = data.commission_rate
        }
      }
    } catch (e) {}
  }
  
  dialogVisible.value = true
}

// 监听商机状态变化，当选择为已签时弹出合同对话框
watch(
  () => opportunityForm.status,
  async (newStatus, oldStatus) => {
    if (newStatus === 'signed' && oldStatus !== 'signed') {
      // 保存当前表单数据
      savedOpportunityForm = { ...opportunityForm }
      // 打开合同创建对话框
      await openContractDialogFromOpportunity()
    }
  }
)

// 监听合同对话框关闭，如果是取消关闭且合同未创建，则恢复商机状态
watch(contractDialogVisible, async (visible) => {
  if (!visible && !pendingOpportunitySubmit && savedOpportunityForm) {
    // 用户取消了合同创建，恢复商机状态为之前的值
    opportunityForm.status = savedOpportunityForm.status
    savedOpportunityForm = null
  }
})

// 加载合同对话框所需的客户列表
const loadCustomersForContract = async () => {
  try {
    const { data } = await request.get('/api/customers', { params: { limit: 100 } })
    customerListForContract.value = data.data || []
  } catch (error) {
    customerListForContract.value = []
  }
}

// 加载合同对话框所需的联系人列表
const loadContactsForContract = async (customerId) => {
  if (!customerId) {
    contactListForContract.value = []
    return
  }
  try {
    const { data } = await request.get('/api/contacts', { params: { customer_id: customerId } })
    contactListForContract.value = data.data || []
  } catch (error) {
    contactListForContract.value = []
  }
}

// 加载合同对话框所需的商机列表
const loadOpportunitiesForContract = async (customerId) => {
  try {
    const { data } = await request.get('/api/opportunities', {
      params: { customer_id: customerId, limit: 100 }
    })
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    opportunityListForContract.value = (data.data || []).filter(opp => opp.creator_id === user.id)
  } catch (error) {
    opportunityListForContract.value = []
  }
}

// 合同对话框客户选择变化
const handleContractCustomerChange = (customerId) => {
  contractForm.contact_id = ''
  loadContactsForContract(customerId)
  loadOpportunitiesForContract(customerId)
}

// 从商机打开合同对话框
const openContractDialogFromOpportunity = async () => {
  // 重置合同表单
  Object.assign(contractForm, {
    id: '', customer_id: '', contact_id: '', opportunity_id: '', title: '', type: '销售合同',
    amount: 0, status: 'active', sign_date: '', effective_date: '',
    expire_date: '', payment_method: '', payment_times: 1,
    payment_plans: [],
    content: '', payment_terms: ''
  })

  // 从商机带过字段
  contractForm.customer_id = savedOpportunityForm.customer_id
  contractForm.contact_id = savedOpportunityForm.contact_id
  contractForm.opportunity_id = savedOpportunityForm.id
  contractForm.title = savedOpportunityForm.name
  contractForm.amount = savedOpportunityForm.amount
  contractForm.content = savedOpportunityForm.description || ''
  // 预计签约时间作为签订日期
  contractForm.sign_date = savedOpportunityForm.expected_sign_date || ''
  contractForm.effective_date = savedOpportunityForm.expected_sign_date || ''

  // 加载下拉选项
  await loadCustomersForContract()
  if (savedOpportunityForm.customer_id) {
    await loadContactsForContract(savedOpportunityForm.customer_id)
    await loadOpportunitiesForContract(savedOpportunityForm.customer_id)
  }

  contractDialogVisible.value = true
}

// 生成合同付款计划
const generateContractPaymentPlans = () => {
  if (!contractForm.payment_method || !contractForm.sign_date) {
    ElMessage.warning('请先选择付款方式和签订日期')
    return
  }

  const signDate = new Date(contractForm.sign_date)
  const plans = []

  if (contractForm.payment_method === 'per_time') {
    const times = contractForm.payment_times || 1
    const amountPerTime = contractForm.amount / times
    for (let i = 0; i < times; i++) {
      const paymentDate = new Date(signDate)
      paymentDate.setDate(paymentDate.getDate() + (i + 1) * 30)
      plans.push({
        amount: parseFloat(amountPerTime.toFixed(2)),
        date: paymentDate.toISOString().split('T')[0]
      })
    }
  } else if (contractForm.payment_method === 'monthly') {
    const amount = contractForm.amount / 12
    for (let i = 0; i < 12; i++) {
      const paymentDate = new Date(signDate)
      paymentDate.setMonth(paymentDate.getMonth() + i + 1)
      paymentDate.setDate(15)
      plans.push({
        amount: parseFloat(amount.toFixed(2)),
        date: paymentDate.toISOString().split('T')[0]
      })
    }
  } else if (contractForm.payment_method === 'quarterly') {
    const amount = contractForm.amount / 4
    for (let i = 0; i < 4; i++) {
      const paymentDate = new Date(signDate)
      paymentDate.setMonth(paymentDate.getMonth() + (i + 1) * 3)
      paymentDate.setDate(15)
      plans.push({
        amount: parseFloat(amount.toFixed(2)),
        date: paymentDate.toISOString().split('T')[0]
      })
    }
  } else if (contractForm.payment_method === 'yearly') {
    const amount = contractForm.amount
    const paymentDate = new Date(signDate)
    paymentDate.setFullYear(paymentDate.getFullYear() + 1)
    paymentDate.setMonth(11)
    paymentDate.setDate(31)
    plans.push({
      amount: parseFloat(amount.toFixed(2)),
      date: paymentDate.toISOString().split('T')[0]
    })
  }

  contractForm.payment_plans = plans
  ElMessage.success('付款计划已生成,可手动调整')
}

// 删除合同付款计划
const removeContractPaymentPlan = (index) => {
  contractForm.payment_plans.splice(index, 1)
}

// 从商机对话框提交合同
const submitContractFromOpportunity = async () => {
  if (!contractFormRef.value) return

  if (!contractForm.payment_plans || contractForm.payment_plans.length === 0) {
    ElMessage.error('请先生成付款计划')
    return
  }

  await contractFormRef.value.validate(async (valid) => {
    if (!valid) return

    contractSubmitting.value = true
    try {
      const submitData = { ...contractForm }
      // 格式化日期
      if (submitData.sign_date) {
        const d = new Date(submitData.sign_date)
        submitData.sign_date = d.toISOString().split('T')[0]
      }
      if (submitData.effective_date) {
        const d = new Date(submitData.effective_date)
        submitData.effective_date = d.toISOString().split('T')[0]
      }
      if (submitData.expire_date) {
        const d = new Date(submitData.expire_date)
        submitData.expire_date = d.toISOString().split('T')[0]
      }
      if (submitData.payment_plans && Array.isArray(submitData.payment_plans)) {
        submitData.payment_plans = submitData.payment_plans.map(plan => ({
          amount: plan.amount,
          date: plan.date ? (new Date(plan.date).toISOString().split('T')[0]) : null
        }))
      }

      await request.post('/api/contracts', submitData)
      ElMessage.success('合同创建成功')
      contractDialogVisible.value = false

      // 合同创建成功后，标记为待提交商机表单
      pendingOpportunitySubmit = true

      // 继续提交商机表单
      await doSubmitOpportunity()
    } catch (error) {
      console.error('合同创建失败:', error)
      ElMessage.error(error.response?.data?.error || '合同创建失败')
    } finally {
      contractSubmitting.value = false
    }
  })
}

// 执行商机表单提交
const doSubmitOpportunity = async () => {
  submitting.value = true
  try {
    if (isEdit.value) {
      await request.put(`/api/opportunities/${opportunityForm.id}`, opportunityForm)
      ElMessage.success('更新成功')
    } else {
      await request.post('/api/opportunities', opportunityForm)
      ElMessage.success('创建成功')
    }
    dialogVisible.value = false
    loadData()
    // 新建/编辑可能带入新的产品名，同步刷新「意向产品」筛选选项
    loadProductOptions()
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message || '操作失败'
    ElMessage.error(errorMsg)
  } finally {
    submitting.value = false
    pendingOpportunitySubmit = false
    savedOpportunityForm = null
  }
}

const submitForm = async () => {
  if (!formRef.value) return

  await formRef.value.validate(async (valid) => {
    if (!valid) {
      ElMessage.error('请检查表单填写是否完整')
      return
    }

    // 如果状态为已签且合同对话框已打开，说明 watch 已触发弹出合同对话框
    // 此时静默返回，等待用户在合同对话框中完成合同创建后自动提交
    if (opportunityForm.status === 'signed' && !pendingOpportunitySubmit && contractDialogVisible.value) {
      return
    }

    // 如果已经完成了合同创建，直接提交商机
    await doSubmitOpportunity()
  })
}

const viewDetail = async (id) => {
  try {
    const { data } = await request.get(`/api/opportunities/${id}`)
    detailData.opportunity = data.opportunity
    detailData.followups = data.followups || []
    detailData.assignments = data.assignments || []
    detailVisible.value = true
  } catch (error) {
    ElMessage.error('加载商机详情失败')
  }
}

const assignmentNames = (type) => detailData.assignments
  .filter(item => item.assignment_type === type)
  .map(item => item.user_name || item.name)
  .filter(Boolean)
  .join('、')

// 指派弹窗标题：按入口来源区分文案
const assignmentDialogTitle = computed(() => {
  const isFde = assignmentForm.assignment_type === 'fde'
  if (assignmentEntry.value === 'row') {
    return isFde ? '设置FDE（支持多人）' : '设置售前'
  }
  return isFde ? '指派FDE（支持多人）' : '指派技术协作人员'
})

// 公共开弹窗流程：加载可指派人员并打开弹窗（调用前需先设置 assignmentTarget）
const openAssignmentDialog = async (type) => {
  assignmentForm.assignment_type = type
  assignmentForm.user_id = ''
  assignmentForm.user_ids = []
  assignmentForm.remark = ''
  try {
    const { data } = await request.get('/api/users', {
      params: { limit: 100, role: type === 'fde' ? 'fde' : 'presales', status: 'active' }
    })
    // FDE 支持多人指派：过滤掉目标商机已在指派中的人员，避免重复提交
    const assignedIds = type === 'fde'
      ? new Set((assignmentTarget.value.assignments || [])
          .filter(item => item.assignment_type === 'fde')
          .map(item => item.user_id))
      : new Set()
    assignmentUsers.value = (data.data || []).filter(user => !assignedIds.has(user.id))
    assignmentVisible.value = true
  } catch (error) {
    ElMessage.error('加载可指派人员失败')
  }
}

// 详情页入口：以当前详情弹窗中的商机为目标
const openAssignment = async (type) => {
  assignmentEntry.value = 'detail'
  assignmentTarget.value = {
    id: detailData.opportunity?.id || '',
    name: detailData.opportunity?.name || '',
    status: detailData.opportunity?.status || '',
    owner_id: detailData.opportunity?.owner_id || '',
    assignments: detailData.assignments || []
  }
  await openAssignmentDialog(type)
}

// 列表"更多"下拉入口：先拉取该商机的详情与指派数据，再走公共开弹窗流程
const openAssignmentForRow = async (row, type) => {
  if (!row?.id) return
  // FDE 指派存在状态门槛：商机进入技术交流及之后的阶段才可指派
  if (type === 'fde' && !fdeAssignableStatuses.includes(row.status)) {
    ElMessage.warning('商机进入技术交流后才可指派FDE')
    return
  }
  try {
    const { data } = await request.get(`/api/opportunities/${row.id}`)
    assignmentEntry.value = 'row'
    assignmentTarget.value = {
      id: data.opportunity?.id || row.id,
      name: data.opportunity?.name || row.name || '',
      status: data.opportunity?.status || row.status || '',
      owner_id: data.opportunity?.owner_id || row.owner_id || '',
      assignments: data.assignments || []
    }
    await openAssignmentDialog(type)
  } catch (error) {
    ElMessage.error('加载商机指派信息失败')
  }
}

const submitAssignment = async () => {
  const isFde = assignmentForm.assignment_type === 'fde'
  const hasTarget = isFde ? assignmentForm.user_ids.length > 0 : !!assignmentForm.user_id
  // 目标商机：以弹窗记录的目标为准（详情入口与列表入口通用）
  const targetId = assignmentTarget.value.id || detailData.opportunity?.id
  if (!hasTarget || !targetId) {
    ElMessage.warning('请选择人员')
    return
  }
  assignmentSubmitting.value = true
  try {
    // FDE 一次可指派多人（人数不限）；售前仍为单人
    const payload = isFde
      ? { assignment_type: 'fde', user_ids: assignmentForm.user_ids, remark: assignmentForm.remark }
      : { assignment_type: 'presales', user_id: assignmentForm.user_id, remark: assignmentForm.remark }
    const { data } = await request.post(`/api/opportunities/${targetId}/assignments`, payload)
    ElMessage.success(data.message || '指派成功')
    assignmentVisible.value = false
    // 若详情弹窗正在展示同一商机，则同步刷新详情内的指派数据
    if (detailVisible.value && detailData.opportunity?.id === targetId) {
      await viewDetail(targetId)
    }
    // 同步刷新列表中的售前/FDE列
    loadData()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '指派失败')
  } finally {
    assignmentSubmitting.value = false
  }
}

// 移除商机级指派（客户级指派需到客户页面处理）
const removeAssignment = (item) => {
  const personName = item.user_name || item.name || '该人员'
  // 按指派类型区分文案：售前 / FDE
  const typeLabel = item.assignment_type === 'presales' ? '售前' : 'FDE'
  ElMessageBox.confirm(`确定要移除「${personName}」的${typeLabel}指派吗？`, '提示', { type: 'warning' })
    .then(async () => {
      try {
        await request.delete(`/api/opportunities/${detailData.opportunity.id}/assignments/${item.id}`)
        ElMessage.success('指派已移除')
        await viewDetail(detailData.opportunity.id)
        // 同步刷新列表中的售前/FDE列
        loadData()
      } catch (error) {
        ElMessage.error(error.response?.data?.error || '移除失败')
      }
    })
    .catch(() => {})
}

const deleteOpportunity = (row) => {
  ElMessageBox.confirm('确定要删除该商机吗？', '提示', { type: 'warning' })
    .then(async () => {
      try {
        await request.delete(`/api/opportunities/${row.id}`)
        ElMessage.success('删除成功')
        loadData()
      } catch (error) {
        const errorMsg = error.response?.data?.error || '删除失败'
        ElMessage.error(errorMsg)
      }
    })
    .catch(() => {})
}

// 处理更多菜单命令
const handleCommand = (command, row) => {
  if (command === 'detail') {
    viewDetail(row.id)
  } else if (command === 'edit') {
    editOpportunity(row)
  } else if (command === 'delete') {
    deleteOpportunity(row)
  } else if (command === 'assign-presales') {
    // 商机级快捷入口：为该商机设置售前
    openAssignmentForRow(row, 'presales')
  } else if (command === 'assign-fde') {
    // 商机级快捷入口：为该商机设置FDE（支持多人）
    openAssignmentForRow(row, 'fde')
  } else if (command === 'followup') {
    // 打开新增跟进对话框
    showFollowupDialog(row)
  }
}

// 显示新增跟进对话框
const showFollowupDialog = (row) => {
  const oppStatus = row.status || ''

  let initialStage = ''
  // 如果商机已经是已签状态，自动将跟进阶段设置为已签
  if (oppStatus === 'signed') {
    initialStage = 'signed'
  }

  Object.assign(followupForm, {
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    opportunity_id: row.id,
    opportunity_name: row.name,
    type: '',
    content: '',
    stage: initialStage,
    result: ''
  })
  followupDialogVisible.value = true
}

// 提交跟进
const submitFollowup = async () => {
  if (!followupFormRef.value) return
  
  await followupFormRef.value.validate(async (valid) => {
    if (!valid) return
    
    followupSubmitting.value = true
    try {
      // 创建跟进记录（后端会自动同步商机状态）
      await request.post('/api/followups', {
        customer_id: followupForm.customer_id,
        opportunity_id: followupForm.opportunity_id,
        type: followupForm.type,
        content: followupForm.content,
        stage: followupForm.stage,
        result: followupForm.result
      })

      ElMessage.success('跟进创建成功')
      followupDialogVisible.value = false
      loadData()
      if (detailVisible.value && followupForm.opportunity_id) {
        viewDetail(followupForm.opportunity_id)
      }
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '创建失败')
    } finally {
      followupSubmitting.value = false
    }
  })
}

onMounted(async () => {
  // 支持从 URL query 初始化状态筛选（数据概览点击跳转时使用）
  if (route.query.status) {
    filters.status = String(route.query.status).split(',').filter(Boolean)
  }
  // 支持从客户详情跳转时带入客户名称过滤，便于在商机上设置售前
  if (route.query.customer_name) {
    filters.customer_name = String(route.query.customer_name)
  }
  await Promise.all([loadData(), loadCustomers(), loadProducts(), loadProductOptions(), loadSales(), loadPresales()])
  
  // 销售新建商机时，负责销售固定为当前登录账号
  const user = JSON.parse(localStorage.getItem('user') || '{}')
  if (user.role === 'sales' && user.id) {
    opportunityForm.owner_id = user.id
  }
  if (route.query.opportunity_id) {
    await viewDetail(String(route.query.opportunity_id))
  }
})
</script>

<style scoped>
.opportunity-list {
  padding: 0;
}

.filter-bar {
  margin-bottom: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border-light);
  padding-bottom: var(--spacing-lg);
}

.filter-bar .el-form-item {
  margin-bottom: var(--spacing-sm);
}

.presales-field-hint {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
}

.summary-bar {
  margin-top: var(--spacing-lg);
  padding: var(--spacing-md) var(--spacing-xl);
  background-color: var(--color-border-extra-light);
  border-radius: 4px;
  text-align: right;
}

.summary-label {
  font-size: 14px;
  color: #646a73;
  font-weight: bold;
}

.summary-value {
  font-size: 16px;
  color: #34c724;
  font-weight: bold;
}

.pagination {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border-light);
  display: flex;
  justify-content: flex-end;
}

.assignment-panel {
  --assignment-card-height: 72px;
  --assignment-action-width: 108px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.assignment-name {
  display: inline-block;
  max-width: 100%;
  color: #646a73;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.assignment-card {
  min-height: var(--assignment-card-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid #dee0e3;
  border-radius: 6px;
  background: #f8f9fa;
}

.assignment-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.assignment-label {
  color: #8f959e;
  font-size: 13px;
}

.assignment-meta strong {
  color: #1f2329;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assignment-action {
  width: var(--assignment-action-width);
  flex: 0 0 var(--assignment-action-width);
}

.assignment-status {
  width: var(--assignment-action-width);
  justify-content: center;
  flex: 0 0 var(--assignment-action-width);
}

.followup-content-cell {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  max-height: 80px;
  overflow-y: auto;
  padding: var(--spacing-xs) 0;
}

@media (max-width: 760px) {
  .assignment-panel {
    grid-template-columns: 1fr;
  }
}
</style>
