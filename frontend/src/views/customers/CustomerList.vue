<template>
  <div class="customer-list">
    <el-card>
      <div class="filter-bar">
        <el-form :inline="true" :model="filters">
          <el-form-item label="客户名称">
            <el-input v-model="filters.name" placeholder="请输入客户名称" clearable />
          </el-form-item>
          <el-form-item label="客户类型">
            <el-select v-model="filters.type" placeholder="全部" clearable style="width: 140px">
              <el-option label="直客" value="direct_customer" />
              <el-option label="外部渠道客户" value="external_channel" />
              <el-option label="公司渠道客户" value="company_channel" />
            </el-select>
          </el-form-item>
          <el-form-item label="客户状态">
            <el-select v-model="filters.status" placeholder="全部" clearable multiple style="width: 180px">
              <el-option label="潜在" value="potential" />
              <el-option label="技术交流" value="technical" />
              <el-option label="POC" value="poc" />
              <el-option label="立项" value="project" />
              <el-option label="招投标" value="bidding" />
              <el-option label="合同中" value="contracting" />
              <el-option label="已签合同" value="signed" />
              <el-option label="丢失" value="lost" />
              <el-option label="黑名单" value="blacklist" />
            </el-select>
          </el-form-item>
          <el-form-item label="客户等级">
            <el-select v-model="filters.level" placeholder="全部" clearable style="width: 80px">
              <el-option label="A" value="A" />
              <el-option label="B" value="B" />
              <el-option label="C" value="C" />
              <el-option label="D" value="D" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="loadData">查询</el-button>
            <el-button @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="toolbar">
        <el-button type="primary" @click="showAddDialog">
          <el-icon><Plus /></el-icon>
          新增客户
        </el-button>
        <el-button :loading="exporting" @click="exportData">
          <el-icon><Download /></el-icon>
          导出
        </el-button>
        <el-button @click="showPoolDialog">
          <el-icon><Pool /></el-icon>
          公海客户
        </el-button>
      </div>

      <el-table
        :data="tableData"
        v-loading="loading"
        style="width: 100%"
        @row-click="handleRowClick"
      >
        <el-table-column prop="name" label="客户名称" min-width="150" />
        <el-table-column prop="level" label="等级" width="60" align="center">
          <template #default="{ row }">
            <el-tag :type="getLevelType(row.level)" size="small" v-if="row.level">
              {{ row.level }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="owner_name" label="归属销售" width="100" v-if="isAdmin" />
        <el-table-column prop="active_opportunity_count" label="在跟商机数" width="110" align="center">
          <template #default="{ row }">
            <span class="metric-count">{{ row.active_opportunity_count || 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="active_opportunity_presales_count" label="商机在跟售前数" min-width="145" align="center">
          <template #default="{ row }">
            <el-button class="metric-link" link type="primary" @click.stop="showOpportunityPresales(row)">
              {{ row.active_opportunity_presales_count || 0 }}
            </el-button>
          </template>
        </el-table-column>
        <!-- 售前统一由「商机管理」指派，此处为该客户在跟商机的售前合集，只读同步展示 -->
        <el-table-column label="售前" width="120" show-overflow-tooltip>
          <template #header>
            <span>售前</span>
            <el-tooltip
              effect="dark"
              placement="top"
              content="售前在「商机管理」中按商机指派，此处自动汇总该客户在跟商机的售前"
            >
              <el-icon class="header-tip-icon"><QuestionFilled /></el-icon>
            </el-tooltip>
          </template>
          <template #default="{ row }">
            <span :class="{ 'unassigned-value': !row.presales_names }">
              {{ row.presales_names || '未指派' }}
            </span>
          </template>
        </el-table-column>
        <!-- 客户级FDE 列已隐藏（改由商机维度指派FDE），开关见 showCustomerFde -->
        <el-table-column v-if="showCustomerFde" label="客户级FDE" width="120" show-overflow-tooltip>
          <template #default="{ row }">
            <span :class="{ 'unassigned-value': !row.customer_fde_name }">
              {{ row.customer_fde_name || '未指派' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="渠道" width="120">
          <template #default="{ row }">
            {{ row.channel_name || '无' }}
          </template>
        </el-table-column>
        <el-table-column prop="last_followup_at" label="最近跟进时间" width="160" />
        <!-- 公海倒计时：从领取/分配/创建当天起算，填写跟进后重置；仅客户归属方角色可见 -->
        <el-table-column v-if="canManageCustomer" label="公海倒计时" width="115" align="center">
          <template #header>
            <span>公海倒计时</span>
            <el-tooltip
              effect="dark"
              placement="top"
              :content="`连续 ${recycleDays} 天无跟进，系统会在每天 00:05 自动把客户移入公海；填写跟进后倒计时重置`"
            >
              <el-icon class="header-tip-icon"><QuestionFilled /></el-icon>
            </el-tooltip>
          </template>
          <template #default="{ row }">
            <span :style="{ color: getRecycleCountdownColor(row.recycle_days_left), fontWeight: 'bold' }">
              {{ getRecycleCountdownText(row.recycle_days_left) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="contract_expire_date" label="合同到期" width="120">
          <template #default="{ row }">
            <span :style="{ color: getExpiryColor(row.contract_expire_date), fontWeight: 'bold' }">
              {{ row.contract_expire_date || '-' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="next_payment_date" label="回款提醒" width="120">
          <template #default="{ row }">
            <span :style="{ color: getPaymentRemindColor(row.next_payment_date), fontWeight: 'bold' }">
              {{ row.next_payment_date || '-' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="industry" label="行业" width="120" />
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(cmd) => handleCommand(cmd, row)" :popper-options="{ modifiers: [{ name: 'computeStyles', options: { adaptive: false } }], strategy: 'fixed' }" popper-class="customer-dropdown">
              <el-button text type="primary" @click.stop>
                更多<el-icon><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="detail">详情</el-dropdown-item>
                  <el-dropdown-item command="edit" v-if="canManageCustomer">编辑</el-dropdown-item>
                  <el-dropdown-item command="assign" v-if="canManageCustomer && !row.owner_id" divided>分配</el-dropdown-item>
                  <el-dropdown-item command="transfer" v-if="canManageCustomer && row.owner_id">转移</el-dropdown-item>
                  <el-dropdown-item command="public" v-if="canManageCustomer" :disabled="row.status === 'public'">移入公海</el-dropdown-item>
                  <el-dropdown-item command="share" v-if="canManageCustomer && row.owner_id" divided>共享客户</el-dropdown-item>
                  <!-- 客户级FDE 指派入口已隐藏，开关见 showCustomerFde -->
                  <el-dropdown-item command="assign-customer-fde" v-if="showCustomerFde && canAssignCustomerFde">设置客户级FDE</el-dropdown-item>
                  <!-- 客户级售前指派入口已隐藏（售前统一在「商机管理」指派），开关见 showCustomerPresalesAssign -->
                  <el-dropdown-item command="assign-customer-presales" v-if="showCustomerPresalesAssign && canManageCustomer">设置客户级售前</el-dropdown-item>
                  <el-dropdown-item command="add-opportunity" v-if="canManageCustomer">添加商机</el-dropdown-item>
                  <el-dropdown-item command="add-contact" v-if="canManageCustomer">新增客户联系人</el-dropdown-item>
                  <el-dropdown-item command="add-followup" v-if="canManageCustomer">新增销售跟进</el-dropdown-item>
                  <el-dropdown-item command="add-presales-followup" v-if="isPresales">新增售前跟进</el-dropdown-item>
                  <el-dropdown-item command="add-contract" v-if="canManageCustomer">新增合同</el-dropdown-item>
                  <el-dropdown-item command="add-payment" v-if="canManageCustomer">新增回款</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>

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

    <el-dialog
      v-model="opportunityPresalesVisible"
      :title="`${opportunityPresalesCustomerName} · 在跟商机售前明细`"
      width="min(920px, 94vw)"
      :close-on-click-modal="false"
    >
      <el-alert
        type="info"
        :closable="false"
        title="这里展示商机级实际售前；客户级默认售前仅用于新增商机时自动带入。"
        class="scope-tip"
      />
      <el-table :data="opportunityPresalesData" v-loading="opportunityPresalesLoading" empty-text="暂无已指派售前的在跟商机">
        <el-table-column prop="name" label="商机名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="products" label="产品" min-width="130" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">{{ getStatusLabel(row.status) }}</template>
        </el-table-column>
        <el-table-column prop="owner_name" label="负责销售" width="110" />
        <el-table-column label="商机级售前" min-width="140">
          <template #default="{ row }">
            <span :class="{ 'unassigned-value': !row.presales_names }">{{ row.presales_names || '未指派' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="expected_sign_date" label="预计签约" width="120" />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="goToOpportunity(row.id)">商机详情</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="opportunityPresalesVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 客户级FDE 指派弹窗已隐藏，开关见 showCustomerFde；弹窗结构与提交逻辑保留不变 -->
    <el-dialog
      v-if="showCustomerFde"
      v-model="customerFdeDialogVisible"
      title="设置客户级FDE"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form label-width="100px">
        <el-form-item label="客户">
          <el-input :model-value="customerFdeForm.customer_name" disabled />
        </el-form-item>
        <el-form-item label="FDE人员" required>
          <el-select v-model="customerFdeForm.user_id" filterable placeholder="请选择FDE" style="width: 100%">
            <el-option v-for="user in fdeList" :key="user.id" :label="user.name" :value="user.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="customerFdeForm.remark" type="textarea" :rows="3" placeholder="可填写协作范围或说明" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        title="客户级FDE用于客户协作，不会替代商机中的FDE指派。"
      />
      <template #footer>
        <el-button @click="customerFdeDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="customerFdeSubmitting" @click="submitCustomerFde">确定</el-button>
      </template>
    </el-dialog>

    <!-- 设置客户级售前对话框：售前已统一在「商机管理」中指派，此处默认隐藏（保留原实现，开关打开即可恢复） -->
    <el-dialog
      v-if="showCustomerPresalesAssign"
      v-model="customerPresalesDialogVisible"
      title="设置客户级售前"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form label-width="100px">
        <el-form-item label="客户">
          <el-input :model-value="customerPresalesForm.customer_name" disabled />
        </el-form-item>
        <el-form-item label="售前人员" required>
          <el-select v-model="customerPresalesForm.user_id" filterable placeholder="请选择售前人员" style="width: 100%">
            <el-option v-for="user in presalesList" :key="user.id" :label="user.name" :value="user.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="customerPresalesForm.remark" type="textarea" :rows="3" placeholder="可填写协作范围或说明" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        title="新指派将替换原有的客户级售前；客户级默认售前会在新增商机时自动带入。"
      />
      <template #footer>
        <el-button @click="customerPresalesDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="customerPresalesSubmitting" @click="submitCustomerPresales">确定</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑客户对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑客户' : '新增客户'"
      width="900px"
      :close-on-click-modal="false"
    >
      <el-form :model="customerForm" :rules="rules" ref="formRef" label-width="120px">
        <el-divider content-position="left">基本信息</el-divider>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户名称" prop="name">
              <el-input v-model="customerForm.name" placeholder="请输入客户名称（必填）" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="客户简称" prop="customer_short_name">
              <el-input v-model="customerForm.customer_short_name" placeholder="请输入客户简称（必填）" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="社会信用代码" prop="credit_code">
              <el-input v-model="customerForm.credit_code" placeholder="请输入社会信用代码" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="客户类型" prop="type">
              <el-select v-model="customerForm.type" placeholder="请选择客户类型（必填）" style="width: 100%" @change="handleCustomerTypeChange">
                <el-option label="外部渠道客户" value="external_channel" />
                <el-option label="直客" value="direct_customer" />
                <el-option label="公司渠道客户" value="company_channel" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="渠道名称" v-if="customerForm.type === 'external_channel' || customerForm.type === 'company_channel'" prop="channel_name">
              <el-select v-model="customerForm.channel_id" placeholder="请选择渠道（必填）" style="width: 100%" filterable @change="handleChannelChange">
                <el-option v-for="ch in channelOptions" :key="ch.id" :label="ch.name" :value="ch.id"/>
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="所属行业" prop="industry">
              <el-select v-model="customerForm.industry" placeholder="请选择行业（必填）" style="width: 100%">
                <el-option label="互联网平台" value="互联网平台" />
                <el-option label="汽车" value="汽车" />
                <el-option label="智能制造" value="智能制造" />
                <el-option label="银行" value="银行" />
                <el-option label="证券" value="证券" />
                <el-option label="保险" value="保险" />
                <el-option label="消金" value="消金" />
                <el-option label="基金" value="基金" />
                <el-option label="零售" value="零售" />
                <el-option label="政府" value="政府" />
                <el-option label="其他" value="其他" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="客户规模">
              <el-select v-model="customerForm.scale" placeholder="请选择规模" style="width: 100%">
                <el-option label="微型 (≤10 人)" value="micro" />
                <el-option label="小型 (11-50 人)" value="small" />
                <el-option label="中型 (51-200 人)" value="medium" />
                <el-option label="大型 (201-1000 人)" value="large" />
                <el-option label="集团 (≥1001 人)" value="group" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="所在地区" prop="region">
              <el-cascader
                v-model="customerForm.region"
                :options="regionOptions"
                placeholder="请选择省/市（必填）"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="详细地址">
              <el-input v-model="customerForm.address" placeholder="请输入详细地址" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="官网">
              <el-input v-model="customerForm.website" placeholder="请输入官网地址" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="公司电话">
              <el-input v-model="customerForm.company_phone" placeholder="请输入公司电话" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="联系人" prop="contact_person">
              <el-input v-model="customerForm.contact_person" placeholder="请输入联系人姓名（必填）" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="联系电话/微信号" prop="phone">
              <el-input v-model="customerForm.phone" placeholder="请输入联系电话/微信号（必填）" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">销售信息</el-divider>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户来源" prop="source">
              <el-select v-model="customerForm.source" placeholder="请选择来源" style="width: 100%">
                <el-option label="线上咨询" value="线上咨询" />
                <el-option label="线下活动" value="线下活动" />
                <el-option label="客户介绍" value="客户介绍" />
                <el-option label="市场活动" value="市场活动" />
                <el-option label="其他" value="其他" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="客户等级">
              <el-select v-model="customerForm.level" placeholder="请选择等级" style="width: 100%">
                <el-option label="A 类 (高意向)" value="A" />
                <el-option label="B 类 (中意向)" value="B" />
                <el-option label="C 类 (低意向)" value="C" />
                <el-option label="D 类 (无意向)" value="D" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">其他信息</el-divider>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户标签">
              <el-select
                v-model="customerForm.tag_ids"
                multiple
                placeholder="请选择标签"
                style="width: 100%"
              >
                <el-option
                  v-for="tag in tagList"
                  :key="tag.id"
                  :label="tag.name"
                  :value="tag.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="归属销售" v-if="isAdmin">
              <el-select
                v-model="customerForm.owner_id"
                placeholder="请选择销售"
                style="width: 100%"
                clearable
              >
                <el-option
                  v-for="user in salesList"
                  :key="user.id"
                  :label="user.name"
                  :value="user.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input
                v-model="customerForm.notes"
                type="textarea"
                :rows="3"
                placeholder="请输入备注信息"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20" v-if="!isEdit">
          <el-col :span="24">
            <el-form-item label="内部备注">
              <el-input
                v-model="customerForm.internal_notes"
                type="textarea"
                :rows="2"
                placeholder="仅内部可见的备注"
              />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm" :loading="submitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 客户详情抽屉 -->
    <el-drawer v-model="detailVisible" title="客户详情" size="70%" direction="rtl" :modal="false">
      <template #default>
        <el-tabs v-if="detailData.customer">
          <el-tab-pane label="基本信息">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="客户名称">{{ detailData.customer.name }}</el-descriptions-item>
            <el-descriptions-item label="客户简称">{{ detailData.customer.customer_short_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="客户类型">
              {{ getCustomerTypeLabel(detailData.customer.type) }}
            </el-descriptions-item>
            <el-descriptions-item label="渠道名称" v-if="detailData.customer.type === 'external_channel' || detailData.customer.type === 'company_channel'">
              {{ detailData.customer.channel_name || '-' }}
              <span v-if="detailData.customer.channel_commission_rate !== null && detailData.customer.channel_commission_rate !== undefined" style="margin-left:8px;color:#34c724;font-weight:bold">
                （{{ detailData.customer.channel_commission_rate }}%）
              </span>
            </el-descriptions-item>
            <el-descriptions-item label="社会信用代码">
              {{ detailData.customer.credit_code || '-' }}
            </el-descriptions-item>
            <el-descriptions-item label="所属行业">{{ detailData.customer.industry || '-' }}</el-descriptions-item>
            <el-descriptions-item label="客户规模">{{ detailData.customer.scale || '-' }}</el-descriptions-item>
            <el-descriptions-item label="意向产品">{{ detailData.customer.products || '-' }}</el-descriptions-item>
            <el-descriptions-item label="客户状态">
              <el-tag :type="detailData.customer.status === 'potential' ? 'primary' : 'info'" size="small">
                {{ detailData.customer.status === 'potential' ? '潜在' : '已成交' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="所在地区">{{ detailData.customer.region || '-' }}</el-descriptions-item>
            <el-descriptions-item label="详细地址">{{ detailData.customer.address || '-' }}</el-descriptions-item>
            <el-descriptions-item label="官网">{{ detailData.customer.website || '-' }}</el-descriptions-item>
            <el-descriptions-item label="公司电话">{{ detailData.customer.company_phone || '-' }}</el-descriptions-item>
            <el-descriptions-item label="联系人">{{ detailData.customer.contact_person || '-' }}</el-descriptions-item>
            <el-descriptions-item label="联系电话">{{ detailData.customer.phone || '-' }}</el-descriptions-item>
            <el-descriptions-item label="客户来源">{{ detailData.customer.source || '-' }}</el-descriptions-item>
            <el-descriptions-item label="客户等级">
              <el-tag :type="getLevelType(detailData.customer.level)" size="small">
                {{ getLevelLabel(detailData.customer.level) }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="客户标签">
              <span v-if="detailData.tags && detailData.tags.length > 0">
                <el-tag v-for="tag in detailData.tags" :key="tag.id" size="small" style="margin-right: 4px;">
                  {{ tag.name }}
                </el-tag>
              </span>
              <span v-else>-</span>
            </el-descriptions-item>
            <el-descriptions-item label="主销售">{{ detailData.customer.owner_name || '-' }}</el-descriptions-item>
            <el-descriptions-item label="售前">
              <div class="customer-assignment-cell">
                <span v-if="detailData.presalesAssignments.length">
                  {{ detailData.presalesAssignments.map(item => item.name).join('、') }}
                </span>
                <el-tag v-else type="info" size="small">未设置</el-tag>
                <span class="customer-assignment-tip">
                  售前在<el-button link type="primary" @click="goToOpportunityFromDetail">商机管理</el-button>中按商机指派
                </span>
              </div>
            </el-descriptions-item>
            <!-- 客户级FDE 详情项已隐藏（含只读展示与设置/取消按钮），开关见 showCustomerFde -->
            <el-descriptions-item v-if="showCustomerFde" label="客户级FDE">
              <div class="customer-assignment-cell">
                <span v-if="detailData.fdeAssignments.length">
                  {{ detailData.fdeAssignments.map(item => item.name).join('、') }}
                </span>
                <el-tag v-else type="info" size="small">未指派</el-tag>
                <span v-if="canAssignCustomerFde" class="customer-assignment-actions">
                  <el-button link type="primary" @click="openCustomerFdeDialog(detailData.customer, detailData.fdeAssignments[0])">
                    {{ detailData.fdeAssignments.length ? '修改' : '设置' }}
                  </el-button>
                  <el-button v-if="detailData.fdeAssignments.length" link type="danger" @click="cancelCustomerFde(detailData.customer.id)">
                    取消
                  </el-button>
                </span>
              </div>
            </el-descriptions-item>
            <el-descriptions-item label="副销售">
              <span v-if="detailData.customer.secondary_owner_name">{{ detailData.customer.secondary_owner_name }}</span>
              <el-tag v-else type="info" size="small">未共享</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="创建时间">{{ detailData.customer.created_at }}</el-descriptions-item>
            <el-descriptions-item label="最近跟进时间">{{ detailData.customer.last_followup_at || '-' }}</el-descriptions-item>
            <el-descriptions-item label="备注" :span="2">{{ detailData.customer.notes || '-' }}</el-descriptions-item>
            <el-descriptions-item label="内部备注" :span="2" v-if="isAdmin">{{ detailData.customer.internal_notes || '-' }}</el-descriptions-item>
          </el-descriptions>
        </el-tab-pane>
        <el-tab-pane label="联系人">
          <el-table :data="detailData.contacts" style="width: 100%">
            <el-table-column prop="name" label="姓名" />
            <el-table-column prop="position" label="职位" />
            <el-table-column prop="phone" label="手机" />
            <el-table-column prop="email" label="邮箱" />
            <el-table-column label="是否 KP">
              <template #default="{ row }">
                <el-tag :type="row.is_kp ? 'danger' : 'info'" size="small">
                  {{ row.is_kp ? '是' : '否' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="跟进记录">
          <el-table :data="detailData.followups" style="width: 100%">
            <el-table-column prop="created_at" label="跟进时间" width="160" />
            <el-table-column prop="type" label="方式" width="80" />
            <el-table-column prop="opportunity_name" label="关联商机" min-width="120" show-overflow-tooltip>
              <template #default="{ row }">
                {{ row.opportunity_name || '-' }}
              </template>
            </el-table-column>
            <el-table-column prop="opportunity_status" label="商机状态" width="100">
              <template #default="{ row }">
                <el-tag v-if="row.opportunity_status" :type="getOpportunityStatusType(row.opportunity_status)" size="small">
                  {{ getOpportunityStatusLabel(row.opportunity_status) }}
                </el-tag>
                <span v-else>-</span>
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
        </el-tab-pane>
        <el-tab-pane label="合同记录">
          <el-table :data="detailData.contracts" style="width: 100%">
            <el-table-column prop="contract_no" label="合同编号" width="150" />
            <el-table-column prop="amount" label="金额" width="120" align="right">
              <template #default="{ row }">
                <span style="white-space: nowrap;">¥{{ (row.amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getContractStatusType(row.status)" size="small">
                  {{ getContractStatusLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="created_at" label="创建时间" width="160" />
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="回款记录">
          <el-table :data="detailData.payments" style="width: 100%" v-loading="detailLoading">
            <el-table-column prop="payment_no" label="回款编号" width="150" />
            <el-table-column prop="contract_no" label="合同编号" width="150" />
            <el-table-column prop="contract_title" label="合同名称" min-width="180" show-overflow-tooltip />
            <el-table-column prop="amount" label="回款金额" width="120" align="right">
              <template #default="{ row }">
                <span style="color: #34c724; font-weight: bold;">
                  ¥{{ (row.amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="actual_date" label="回款日期" width="120" />
            <el-table-column prop="method" label="回款方式" width="100">
              <template #default="{ row }">
                {{ getMethodLabel(row.method) }}
              </template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="80" align="center">
              <template #default="{ row }">
                <el-tag :type="row.status === '已回款' ? 'success' : 'info'" size="small">
                  {{ row.status === '已回款' ? '已回款' : row.status }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="!detailData.payments || detailData.payments.length === 0" style="text-align: center; padding: 20px; color: #8f959e;">
            暂无回款记录
          </div>
        </el-tab-pane>
        <el-tab-pane label="变更日志">
          <el-table :data="detailData.changeLogs" style="width: 100%" v-if="detailData.changeLogs && detailData.changeLogs.length > 0">
            <el-table-column prop="changed_at" label="变更时间" width="160" />
            <el-table-column prop="changed_by_name" label="变更人" width="100" />
            <el-table-column prop="field_name" label="变更字段" width="150" />
            <el-table-column label="变更前值" min-width="200">
              <template #default="{ row }">
                <span style="color: #f54a45;">{{ row.old_value || '(空)' }}</span>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="暂无变更记录" :image-size="80" />
        </el-tab-pane>
        </el-tabs>
      </template>
    </el-drawer>

    <!-- 公海客户抽屉 -->
    <el-drawer v-model="poolDialogVisible" title="公海客户" size="70%" direction="rtl">
      <template #default>
        <div class="pool-toolbar">
          <el-input
            v-model="poolSearch"
            placeholder="请输入客户名称搜索"
            clearable
            style="width: 300px; margin-bottom: 10px;"
            @clear="loadPoolCustomers"
            @keyup.enter="onPoolSearch"
          >
            <template #append>
              <el-button @click="onPoolSearch">
                <el-icon><Search /></el-icon>
              </el-button>
            </template>
          </el-input>
          <el-alert
            title="公海客户说明"
            type="info"
            :closable="false"
            show-icon
          >
            <p>公海客户是指未分配给具体销售的客户，所有销售均可领取。</p>
            <p>保护期内的客户不可被其他销售领取。</p>
          </el-alert>
        </div>

        <el-table :data="poolData" v-loading="poolLoading" stripe>
          <el-table-column prop="name" label="客户名称" min-width="150" />
          <el-table-column prop="customer_short_name" label="简称" width="100" />
          <el-table-column prop="type" label="类型" width="100">
            <template #default="{ row }">
              <el-tag :type="row.type === 'enterprise' ? 'primary' : 'success'" size="small">
                {{ row.type === 'enterprise' ? '企业' : '个人' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="level" label="等级" width="60" align="center">
            <template #default="{ row }">
              <el-tag :type="getLevelType(row.level)" size="small" v-if="row.level">
                {{ row.level }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="source" label="来源" width="100" />
          <el-table-column prop="contact_person" label="联系人" width="100" />
          <el-table-column prop="phone" label="联系电话" width="120" />
          <el-table-column prop="public_at" label="移入公海时间" width="160" />
          <el-table-column prop="public_reason" label="移入原因" min-width="150" show-overflow-tooltip />
          <el-table-column prop="protect_days" label="保护期" width="80" align="center">
            <template #default="{ row }">
              <el-tag :type="row.protect_days > 0 ? 'warning' : 'info'" size="small">
                {{ row.protect_days }}天
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button 
                type="primary" 
                size="small" 
                @click="claimPoolCustomer(row.id)"
                :loading="row.claiming"
              >
                领取
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pool-pagination">
          <el-pagination
            v-model:current-page="poolPagination.page"
            v-model:page-size="poolPagination.limit"
            :page-sizes="[10, 20, 50, 100]"
            :total="poolPagination.total"
            layout="total, sizes, prev, pager, next, jumper"
            @size-change="loadPoolCustomers"
            @current-change="loadPoolCustomers"
          />
        </div>
      </template>
    </el-drawer>

    <!-- 分配/转移对话框 -->
    <el-dialog
      v-model="assignDialogVisible"
      :title="assignType === 'assign' ? '分配客户' : '转移客户'"
      width="500px"
    >
      <el-form :model="assignForm" label-width="100px">
        <el-form-item label="目标销售" v-if="assignType === 'assign'">
          <el-select
            v-model="assignForm.owner_id"
            placeholder="请选择销售"
            style="width: 100%"
          >
            <el-option
              v-for="user in salesList"
              :key="user.id"
              :label="user.name"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="目标销售" v-else>
          <el-select
            v-model="assignForm.target_owner_id"
            placeholder="请选择销售"
            style="width: 100%"
          >
            <el-option
              v-for="user in salesList"
              :key="user.id"
              :label="user.name"
              :value="user.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="保护期（天）" v-if="assignType === 'assign'">
          <el-input-number v-model="assignForm.protect_days" :min="0" :max="30" />
        </el-form-item>
        <el-form-item label="转移原因" v-else>
          <el-input
            v-model="assignForm.reason"
            type="textarea"
            :rows="3"
            placeholder="请输入转移原因"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="assignDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAssign" :loading="assignSubmitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 共享客户对话框 -->
    <el-dialog
      v-model="shareDialogVisible"
      title="共享客户"
      width="500px"
    >
      <el-form :model="shareForm" label-width="140px">
        <el-form-item label="共享给销售">
          <el-select
            v-model="shareForm.secondary_owner_id"
            placeholder="请选择销售"
            style="width: 100%"
            filterable
          >
            <el-option
              v-for="sales in salesList"
              :key="sales.id"
              :label="sales.name"
              :value="sales.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="主销售分成比例">
          <el-input-number
            v-model="shareForm.owner_share_percent"
            :min="0"
            :max="100"
            :step="5"
            style="width: 100%"
          />
          <span style="margin-left: 10px;">%</span>
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
        >
          <p>副销售可以查看客户详情、创建商机，但不能编辑客户信息。</p>
          <p>每个客户最多支持两个销售同时跟进。</p>
          <p>主销售分成比例用于计算合同额分配，默认为 50%。</p>
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="shareDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitShare" :loading="shareSubmitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 添加商机对话框 -->
    <el-dialog
      v-model="opportunityDialogVisible"
      title="添加商机"
      width="900px"
      :close-on-click-modal="false"
    >
      <el-form :model="opportunityForm" :rules="opportunityRules" ref="opportunityFormRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="商机名称" prop="name">
              <el-input v-model="opportunityForm.name" placeholder="请输入商机名称（必填）" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="关联客户" prop="customer_id">
              <el-input v-model="opportunityForm.customer_name" disabled />
              <input type="hidden" v-model="opportunityForm.customer_id" />
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
                  v-for="contact in opportunityContactList"
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
                @click="showCreateContactFromOpp"
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
          <el-col :span="12">
            <el-form-item label="负责销售" prop="owner_id">
              <el-select
                v-model="opportunityForm.owner_id"
                filterable
                :placeholder="currentUser.role === 'sales' ? '当前登录销售' : '请选择负责销售（必填）'"
                :disabled="currentUser.role === 'sales'"
                style="width: 100%"
              >
                <el-option v-for="sales in salesList" :key="sales.id" :label="sales.name" :value="sales.id" />
              </el-select>
              <div class="field-hint">该销售将负责此商机，并获得对应客户的业务查看权限</div>
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
                <el-option label="SREAgent-产品" value="SREAgent-产品" />
                <el-option label="Sky DataPilot" value="Sky DataPilot" />
                <el-option label="Sky CostPilot" value="Sky CostPilot" />
                <el-option label="SREAgent-服务" value="SREAgent-服务" />
                <el-option label="咨询" value="咨询" />
                <el-option label="其他" value="其他" />
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
              <div class="field-hint">
                {{ opportunityForm.presales_user_id ? '商机级指派可独立修改，不影响客户级默认售前' : '本商机暂不指派售前' }}
              </div>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="opportunityDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitOpportunity" :loading="opportunitySubmitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 创建联系人对话框（用于商机添加） -->
    <el-dialog
      v-model="oppContactDialogVisible"
      title="创建联系人"
      width="500px"
    >
      <el-form :model="oppContactForm" :rules="oppContactRules" ref="oppContactFormRef" label-width="100px">
        <el-form-item label="姓名" prop="name">
          <el-input v-model="oppContactForm.name" placeholder="请输入联系人姓名（必填）" />
        </el-form-item>
        <el-form-item label="职位" prop="position">
          <el-input v-model="oppContactForm.position" placeholder="请输入职位" />
        </el-form-item>
        <el-form-item label="手机" prop="phone">
          <el-input v-model="oppContactForm.phone" placeholder="请输入手机号码（必填）" maxlength="11" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="oppContactForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="是否 KP">
          <el-switch v-model="oppContactForm.is_kp" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="oppContactDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitOppContact" :loading="oppContactSubmitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 新增客户联系人对话框 -->
    <el-dialog
      v-model="contactDialogVisible"
      title="新增客户联系人"
      width="700px"
      :close-on-click-modal="false"
    >
      <el-form :model="contactForm" :rules="contactRules" ref="contactFormRef" label-width="100px">
        <el-form-item label="客户">
          <el-input v-model="contactForm.customer_name" disabled />
        </el-form-item>
        <el-form-item label="姓名" prop="name">
          <el-input v-model="contactForm.name" placeholder="请输入联系人姓名" />
        </el-form-item>
        <el-form-item label="职位">
          <el-input v-model="contactForm.position" placeholder="请输入职位" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="contactForm.phone" placeholder="请输入手机号" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="contactForm.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="微信">
          <el-input v-model="contactForm.wechat" placeholder="请输入微信号" />
        </el-form-item>
        <el-form-item label="生日">
          <el-date-picker
            v-model="contactForm.birthday"
            type="date"
            placeholder="选择生日"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="是否 KP">
          <el-switch v-model="contactForm.is_kp" :active-value="1" :inactive-value="0" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input
            v-model="contactForm.notes"
            type="textarea"
            :rows="3"
            placeholder="请输入备注"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="contactDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitContact" :loading="contactSubmitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 新增销售跟进对话框 -->
    <el-dialog
      v-model="followupDialogVisible"
      :title="isPresales ? '新增售前跟进' : '新增销售跟进'"
      width="800px"
      :close-on-click-modal="false"
    >
      <el-form :model="followupForm" :rules="isPresales ? presalesFollowupRules : followupRules" ref="followupFormRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户">
              <el-input v-model="followupForm.customer_name" disabled />
            </el-form-item>
          </el-col>
          <el-col v-if="!isPresales" :span="12">
            <el-form-item label="关联商机" prop="opportunity_id">
              <el-select
                v-model="followupForm.opportunity_id"
                placeholder="请选择商机（必填）"
                filterable
                style="width: 100%"
              >
                <el-option
                  v-for="opp in followupOpportunityList"
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
        <el-row v-if="!isPresales" :gutter="20">
          <el-col :span="12">
            <el-form-item label="跟进阶段">
              <el-select v-model="followupForm.stage" placeholder="请选择阶段" style="width: 100%">
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

    <!-- 新增合同对话框 -->
    <el-dialog
      v-model="contractDialogVisible"
      title="新增合同"
      width="900px"
      :close-on-click-modal="false"
    >
      <el-form :model="contractForm" :rules="contractRules" ref="contractFormRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="客户">
              <el-input v-model="contractForm.customer_name" disabled />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="关联商机" prop="opportunity_id">
              <el-select
                v-model="contractForm.opportunity_id"
                placeholder="请选择关联商机（必填）"
                filterable
                style="width: 100%"
              >
                <el-option
                  v-for="opp in contractOpportunityList"
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
              >
                <el-option
                  v-for="contact in contractContactList"
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
          <el-col :span="24">
            <el-form-item label="付款条款">
              <el-input
                v-model="contractForm.payment_terms"
                type="textarea"
                :rows="3"
                placeholder="请输入付款条款"
              />
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
            <el-form-item label="付款次数">
              <el-input-number
                v-model="contractForm.payment_times"
                :min="1"
                :max="4"
                :disabled="contractForm.payment_method !== 'per_time'"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          title="付款计划为必填项，请选择付款方式并选择签订日期后点击「生成付款计划」"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 15px"
        />
        <div v-if="contractForm.payment_method && contractForm.sign_date" style="margin-bottom: 15px">
          <el-button type="primary" size="small" @click="generateContractPaymentPlans">生成付款计划</el-button>
        </div>
        <div v-if="contractForm.payment_plans && contractForm.payment_plans.length > 0" style="margin-bottom: 15px; padding: 15px; border: 1px solid #dee0e3; border-radius: 4px;">
          <el-divider>付款计划</el-divider>
          <div v-for="(plan, index) in contractForm.payment_plans" :key="index" style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
            <span>第{{ index + 1 }}期：¥{{ (plan.amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}，日期：{{ plan.date }}</span>
            <el-button type="danger" size="small" @click="removeContractPaymentPlan(index)">删除</el-button>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="contractDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitContract" :loading="contractSubmitting">确定</el-button>
      </template>
    </el-dialog>

    <!-- 新增回款对话框 -->
    <el-dialog
      v-model="paymentDialogVisible"
      title="新增回款"
      width="800px"
      :close-on-click-modal="false"
    >
      <el-form :model="paymentForm" :rules="paymentRules" ref="paymentFormRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="合同" prop="contract_id">
              <el-select
                v-model="paymentForm.contract_id"
                placeholder="请选择合同"
                filterable
                style="width: 100%"
                @change="handlePaymentContractChange"
              >
                <el-option
                  v-for="contract in paymentContractList"
                  :key="contract.id"
                  :label="contract.contract_no + ' - ' + contract.title"
                  :value="contract.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="客户">
              <el-input v-model="paymentForm.customer_name" disabled />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="回款金额" prop="amount">
              <el-input-number
                v-model="paymentForm.amount"
                :min="0"
                :precision="2"
                :step="1000"
                style="width: 100%"
                placeholder="请输入回款金额"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="回款日期" prop="actual_date">
              <el-date-picker
                v-model="paymentForm.actual_date"
                type="date"
                placeholder="选择回款日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="回款方式" prop="method">
              <el-select v-model="paymentForm.method" placeholder="请选择回款方式" style="width: 100%">
                <el-option label="银行转账" value="bank_transfer" />
                <el-option label="支票" value="check" />
                <el-option label="现金" value="cash" />
                <el-option label="承兑汇票" value="bill" />
                <el-option label="其他" value="other" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="回款状态">
              <el-select v-model="paymentForm.status" placeholder="请选择状态" style="width: 100%">
                <el-option label="已回款" value="received" />
                <el-option label="待回款" value="pending" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input
                v-model="paymentForm.notes"
                type="textarea"
                :rows="3"
                placeholder="请输入备注"
              />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="paymentDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPayment" :loading="paymentSubmitting">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'
import { downloadBlobResponse } from '@/utils/download'
import { regionOptions } from '@/data/regions'

const router = useRouter()
const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
const isPresales = currentUser.role === 'presales'
const canManageCustomer = ['sales', 'admin', 'super_admin'].includes(currentUser.role)
const canAssignCustomerFde = ['sales', 'fde_admin', 'admin', 'super_admin'].includes(currentUser.role)
// 客户级FDE 已从客户管理页隐藏：不再在客户维度指派FDE，如需恢复改为 true
const showCustomerFde = false
// 客户级售前指派入口已从客户管理页隐藏：售前统一在「商机管理」中按商机指派与取消，
// 客户管理页只做只读同步展示。如需恢复客户维度指派改为 true
const showCustomerPresalesAssign = false
const loading = ref(false)
const exporting = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const detailVisible = ref(false)
const opportunityPresalesVisible = ref(false)
const opportunityPresalesLoading = ref(false)
const opportunityPresalesCustomerName = ref('')
const opportunityPresalesData = ref([])
const customerFdeDialogVisible = ref(false)
const customerFdeSubmitting = ref(false)
const poolDialogVisible = ref(false)
const assignDialogVisible = ref(false)
const shareDialogVisible = ref(false)
const isEdit = ref(false)
const assignType = ref('assign')
const assignSubmitting = ref(false)
const shareSubmitting = ref(false)
const formRef = ref(null)
const shareForm = reactive({
  customer_id: '',
  secondary_owner_id: '',
  owner_share_percent: 50
})

// 添加商机相关状态
const opportunityDialogVisible = ref(false)
const opportunitySubmitting = ref(false)
const opportunityFormRef = ref(null)
const opportunityContactList = ref([])
const oppContactDialogVisible = ref(false)
const oppContactSubmitting = ref(false)
const oppContactFormRef = ref(null)
const oppContactForm = reactive({
  customer_id: '',
  name: '',
  position: '',
  phone: '',
  email: '',
  is_kp: false
})
const oppContactRules = {
  name: [
    { required: true, message: '请输入联系人姓名', trigger: 'blur' }
  ],
  phone: [
    { required: true, message: '请输入手机号码', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号格式', trigger: 'blur' }
  ]
}

const opportunityForm = reactive({
  id: '',
  name: '',
  customer_id: '',
  customer_name: '',
  contact_id: '',
  type: '',
  description: '',
  products: '',
  expected_sign_date: '',
  competitors: '',
  amount: 0,
  owner_id: '',
  presales_user_id: '',
  status: 'potential'
})

const opportunityRules = {
  name: [
    { required: true, message: '请输入商机名称', trigger: 'blur' }
  ],
  customer_id: [
    { required: true, message: '请选择关联客户', trigger: 'change' }
  ],
  contact_id: [
    { required: true, message: '请选择客户联系人', trigger: 'change' }
  ],
  type: [
    { required: true, message: '请选择商机类型', trigger: 'change' }
  ],
  owner_id: [
    { required: true, message: '请选择负责销售', trigger: 'change' }
  ],
  expected_sign_date: [
    { required: true, message: '请选择预计签约时间', trigger: 'change' }
  ],
  amount: [
    { required: true, message: '请输入商机金额', trigger: 'blur' }
  ]
}

// 新增客户联系人相关状态
const contactDialogVisible = ref(false)
const contactSubmitting = ref(false)
const contactFormRef = ref(null)
const contactForm = reactive({
  customer_id: '',
  customer_name: '',
  name: '',
  position: '',
  phone: '',
  email: '',
  wechat: '',
  is_kp: 0,
  birthday: '',
  notes: ''
})
const contactRules = {
  customer_id: [{ required: true, message: '请选择客户', trigger: 'change' }],
  name: [{ required: true, message: '请输入联系人姓名', trigger: 'blur' }]
}

// 新增销售跟进相关状态
const followupDialogVisible = ref(false)
const followupSubmitting = ref(false)
const followupFormRef = ref(null)
const followupOpportunityList = ref([])
const followupForm = reactive({
  customer_id: '',
  customer_name: '',
  opportunity_id: '',
  type: '',
  content: '',
  stage: '',
  result: ''
})
const followupRules = {
  customer_id: [{ required: true, message: '请选择客户', trigger: 'change' }],
  opportunity_id: [{ required: true, message: '请选择关联商机', trigger: 'change' }],
  type: [{ required: true, message: '请选择跟进方式', trigger: 'change' }],
  content: [
    { required: true, message: '请输入跟进内容', trigger: 'blur' },
    { min: 10, message: '跟进内容至少 10 个字', trigger: 'blur' }
  ]
}
const presalesFollowupRules = {
  type: [{ required: true, message: '请选择跟进方式', trigger: 'change' }],
  content: [
    { required: true, message: '请输入跟进内容', trigger: 'blur' },
    { min: 10, message: '跟进内容至少 10 个字', trigger: 'blur' }
  ]
}

// 新增合同相关状态
const contractDialogVisible = ref(false)
const contractSubmitting = ref(false)
const contractFormRef = ref(null)
const contractOpportunityList = ref([])
const contractContactList = ref([])
const contractForm = reactive({
  customer_id: '',
  customer_name: '',
  contact_id: '',
  opportunity_id: '',
  title: '',
  type: '销售合同',
  amount: 0,
  status: 'active',
  sign_date: '',
  effective_date: '',
  expire_date: '',
  payment_method: '',
  payment_times: 1,
  payment_plans: [],
  content: '',
  payment_terms: ''
})
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

// 新增回款相关状态
const paymentDialogVisible = ref(false)
const paymentSubmitting = ref(false)
const paymentFormRef = ref(null)
const paymentContractList = ref([])
const paymentForm = reactive({
  customer_id: '',
  customer_name: '',
  contract_id: '',
  amount: 0,
  actual_date: '',
  method: '',
  status: '已回款',
  notes: ''
})
const paymentRules = {
  contract_id: [{ required: true, message: '请选择合同', trigger: 'change' }],
  amount: [{ required: true, message: '请输入回款金额', trigger: 'blur' }],
  actual_date: [{ required: true, message: '请选择回款日期', trigger: 'change' }]
}

const isAdmin = ref(false)
const filters = reactive({
  name: '',
  type: '',
  status: [],
  level: ''
})

const tableData = ref([])
// 公海自动释放天数，由客户列表接口返回，用于倒计时表头提示文案
const recycleDays = ref(30)
const poolData = ref([])
const poolLoading = ref(false)
const poolSearch = ref('')
const poolPagination = reactive({
  page: 1,
  limit: 10,
  total: 0
})
const pagination = reactive({
  page: 1,
  limit: 10,
  total: 0
})

const tagList = ref([])
const salesList = ref([])
const presalesList = ref([])
const fdeList = ref([])
const channelOptions = ref([])

// 地区选项（省/市） - 从独立文件导入


const customerForm = reactive({
  id: '',
  name: '',
  customer_short_name: '',
  type: '',
  channel_name: '',
  channel_id: '',
  credit_code: '',
  industry: '',
  scale: '',
  region: [],
  address: '',
  website: '',
  company_phone: '',
  contact_person: '',
  phone: '',
  source: '',
  level: '',
  tag_ids: [],
  owner_id: null,
  notes: '',
  internal_notes: ''
})

const assignForm = reactive({
  customer_id: '',
  owner_id: null,
  target_owner_id: null,
  protect_days: 0,
  reason: ''
})

const detailData = reactive({
  customer: null,
  contacts: [],
  followups: [],
  contracts: [],
  tags: [],
  payments: [],
  changeLogs: [],
  presalesAssignments: [],
  fdeAssignments: []
})

const customerFdeForm = reactive({
  customer_id: '',
  customer_name: '',
  user_id: '',
  remark: ''
})

// 设置客户级售前对话框状态
const customerPresalesDialogVisible = ref(false)
const customerPresalesSubmitting = ref(false)
const customerPresalesForm = reactive({
  customer_id: '',
  customer_name: '',
  user_id: '',
  remark: ''
})

const rules = {
  name: [
    { required: true, message: '请输入客户名称', trigger: 'blur' },
    { min: 2, max: 100, message: '客户名称长度在 2-100 个字符', trigger: 'blur' }
  ],
  customer_short_name: [
    { required: true, message: '请输入客户简称', trigger: 'blur' },
    { min: 1, max: 50, message: '客户简称长度在 1-50 个字符', trigger: 'blur' }
  ],
  type: [
    { required: true, message: '请选择客户类型', trigger: 'change' }
  ],
  industry: [
    { required: true, message: '请选择所属行业', trigger: 'change' }
  ],
  region: [
    {
      validator: (rule, value, callback) => {
        if (!value || value.length === 0) {
          callback(new Error('请选择所在地区'))
        } else {
          callback()
        }
      },
      trigger: 'change'
    }
  ],
  channel_name: [
    {
      validator: (rule, value, callback) => {
        if (customerForm.type === 'external_channel' || customerForm.type === 'company_channel') {
          if (!value) {
            callback(new Error('渠道客户必须填写渠道名称'))
          } else {
            callback()
          }
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ],
  industry: [
    { required: true, message: '请选择所属行业', trigger: 'change' }
  ],
  phone: [
    { required: true, message: '请输入联系电话/微信号', trigger: 'blur' }
  ],
  contact_person: [
    { required: true, message: '请输入联系人', trigger: 'blur' },
    { max: 50, message: '联系人不能超过 50 个字符', trigger: 'blur' }
  ],
  email: [
    {
      validator: (rule, value, callback) => {
        if (!value) {
          callback()
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          callback(new Error('请输入正确的邮箱格式'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
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
    lost: 'danger',
    blacklist: 'danger',
    public: ''
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
    lost: '已丢失',
    blacklist: '黑名单',
    public: '公海'
  }
  return map[status] || status
}

const getContractStatusType = (status) => {
  const map = {
    active: 'primary',
    completed: 'success',
    terminated: 'danger',
    draft: 'info',
    pending: 'warning',
    approved: 'success'
  }
  return map[status] || ''
}

const getContractStatusLabel = (status) => {
  const map = {
    active: '执行中',
    completed: '已完成',
    terminated: '已终止',
    draft: '草稿',
    pending: '待审核',
    approved: '已审核'
  }
  return map[status] || status || '-'
}

const getLevelType = (level) => {
  const map = { A: 'danger', B: 'warning', C: '', D: 'info' }
  return map[level] || ''
}

const getLevelLabel = (level) => {
  const map = { 
    A: 'A 类 (高意向)', 
    B: 'B 类 (中意向)', 
    C: 'C 类 (低意向)', 
    D: 'D 类 (无意向)' 
  }
  return map[level] || level || '-'
}

const getTagName = (tagId) => {
  const tag = tagList.value.find(t => t.id === tagId)
  return tag ? tag.name : '-'
}

const getOpportunityStatusType = (status) => {
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

const getOpportunityStatusLabel = (status) => {
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
  return map[status] || status || '-'
}

const getMethodLabel = (method) => {
  const map = {
    bank_transfer: '银行转账',
    check: '支票',
    cash: '现金',
    bill: '承兑汇票',
    other: '其他'
  }
  return map[method] || method || '-'
}

// 获取客户类型标签
const getCustomerTypeLabel = (type) => {
  const map = {
    external_channel: '外部渠道客户',
    direct_customer: '直客',
    company_channel: '公司渠道客户',
    enterprise: '企业客户',
    individual: '个人客户'
  }
  return map[type] || type || '-'
}

// 获取合同到期颜色
const getExpiryColor = (date) => {
  if (!date) return 'inherit'
  const now = new Date()
  const expiry = new Date(date)
  const diffDays = Math.floor((expiry - now) / (1000 * 60 * 60 * 24))
  
  if (diffDays < 0) return '#f54a45' // 已过期 - 红色
  if (diffDays <= 7) return '#ff8800' // 7 天内 - 橙色
  if (diffDays <= 30) return '#8f959e' // 30 天内 - 灰色
  return 'inherit' // 正常
}

// 获取回款提醒颜色
const getPaymentRemindColor = (date) => {
  if (!date) return 'inherit'
  const now = new Date()
  const remind = new Date(date)
  const diffDays = Math.floor((remind - now) / (1000 * 60 * 60 * 24))
  
  if (diffDays < 0) return '#f54a45' // 已逾期 - 红色
  if (diffDays <= 3) return '#ff8800' // 3 天内 - 橙色
  if (diffDays <= 7) return '#8f959e' // 7 天内 - 灰色
  return 'inherit' // 正常
}

// 获取公海倒计时文案：剩余天数由后端按回收任务的同一口径算好返回
const getRecycleCountdownText = (daysLeft) => {
  if (daysLeft === null || daysLeft === undefined) return '-'
  if (daysLeft <= 0) return '已到期'
  return `剩 ${daysLeft} 天`
}

// 获取公海倒计时颜色
const getRecycleCountdownColor = (daysLeft) => {
  if (daysLeft === null || daysLeft === undefined) return 'inherit'
  if (daysLeft <= 3) return '#f54a45' // 已到期或 3 天内 - 红色
  if (daysLeft <= 7) return '#ff8800' // 7 天内 - 橙色
  return '#8f959e' // 其余 - 灰色
}

const loadData = async () => {
  loading.value = true
  try {
    const params = {
      page: pagination.page,
      limit: pagination.limit,
      name: filters.name || undefined,
      type: filters.type || undefined,
      status: filters.status && filters.status.length > 0 ? filters.status.join(',') : undefined,
      level: filters.level || undefined,
      exclude_public: 'true'
    }
    const { data } = await request.get('/api/customers', { params })
    tableData.value = data.data
    recycleDays.value = data.recycle_days || 30
    pagination.total = data.pagination.total
  } catch (error) {
    ElMessage.error('加载客户列表失败')
  } finally {
    loading.value = false
  }
}

const loadTags = async () => {
  try {
    const { data } = await request.get('/api/customer-tags/list')
    tagList.value = data.tags
  } catch (error) {
    // 忽略错误
  }
}

const loadSales = async () => {
  try {
    const { data } = await request.get('/api/users', { params: { limit: 100, role: 'sales', status: 'active' } })
    salesList.value = data.data || []
  } catch (error) {
    // 忽略错误
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

const loadFdeUsers = async () => {
  try {
    const { data } = await request.get('/api/users', { params: { limit: 100, role: 'fde', status: 'active' } })
    fdeList.value = data.data || []
  } catch (error) {
    fdeList.value = []
    ElMessage.error('加载FDE人员失败')
  }
}

const openCustomerFdeDialog = async (customer, assignment = null) => {
  if (!canAssignCustomerFde || !customer) return
  if (!fdeList.value.length) await loadFdeUsers()
  Object.assign(customerFdeForm, {
    customer_id: customer.id,
    customer_name: customer.name,
    user_id: assignment?.user_id || customer.customer_fde_id || '',
    remark: assignment?.remark || ''
  })
  customerFdeDialogVisible.value = true
}

const refreshCustomerFde = async (customerId) => {
  await loadData()
  if (detailVisible.value && detailData.customer?.id === customerId) {
    await viewDetail(customerId)
  }
}

const submitCustomerFde = async () => {
  if (!customerFdeForm.user_id) {
    ElMessage.warning('请选择FDE人员')
    return
  }
  customerFdeSubmitting.value = true
  try {
    await request.post(`/api/customers/${customerFdeForm.customer_id}/fde`, {
      user_id: customerFdeForm.user_id,
      remark: customerFdeForm.remark
    })
    ElMessage.success('客户级FDE设置成功')
    customerFdeDialogVisible.value = false
    await refreshCustomerFde(customerFdeForm.customer_id)
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '客户级FDE设置失败')
  } finally {
    customerFdeSubmitting.value = false
  }
}

// 打开客户级售前指派对话框；默认带入当前客户级默认售前，重新选择即更换
const openCustomerPresalesDialog = async (customer) => {
  if (!canManageCustomer || !customer) return
  if (!presalesList.value.length) await loadPresales()
  Object.assign(customerPresalesForm, {
    customer_id: customer.id,
    customer_name: customer.name,
    user_id: customer.default_presales_id || '',
    remark: ''
  })
  customerPresalesDialogVisible.value = true
}

// 提交客户级售前指派：后端为覆盖模式，新指派自动替换旧指派
const submitCustomerPresales = async () => {
  if (!customerPresalesForm.user_id) {
    ElMessage.warning('请选择售前人员')
    return
  }
  customerPresalesSubmitting.value = true
  try {
    await request.post(`/api/customers/${customerPresalesForm.customer_id}/presales`, {
      user_id: customerPresalesForm.user_id,
      remark: customerPresalesForm.remark
    })
    ElMessage.success('客户级售前指派成功')
    customerPresalesDialogVisible.value = false
    await loadData()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '客户级售前指派失败')
  } finally {
    customerPresalesSubmitting.value = false
  }
}

const cancelCustomerFde = async (customerId) => {
  try {
    await ElMessageBox.confirm('确定取消该客户的客户级FDE指派吗？', '取消指派', { type: 'warning' })
    await request.post(`/api/customers/${customerId}/fde/cancel`)
    ElMessage.success('客户级FDE指派已取消')
    await refreshCustomerFde(customerId)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error.response?.data?.error || '取消客户级FDE失败')
    }
  }
}

// 取消客户级默认售前指派，效果与取消客户级FDE一致
const cancelCustomerPresales = async (customerId) => {
  try {
    await ElMessageBox.confirm('确定取消该客户的客户级默认售前指派吗？', '取消指派', { type: 'warning' })
    await request.post(`/api/customers/${customerId}/presales/cancel`)
    ElMessage.success('客户级售前指派已取消')
    await refreshCustomerPresales(customerId)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(error.response?.data?.error || '取消客户级售前失败')
    }
  }
}

// 取消售前指派后刷新列表与详情抽屉（与 refreshCustomerFde 逻辑一致）
const refreshCustomerPresales = async (customerId) => {
  await loadData()
  if (detailVisible.value && detailData.customer?.id === customerId) {
    await viewDetail(customerId)
  }
}

const showOpportunityPresales = async (row) => {
  opportunityPresalesCustomerName.value = row.name
  opportunityPresalesData.value = []
  opportunityPresalesVisible.value = true
  opportunityPresalesLoading.value = true
  try {
    const { data } = await request.get(`/api/customers/${row.id}/opportunity-presales`)
    opportunityPresalesData.value = data.data || []
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '加载商机售前明细失败')
  } finally {
    opportunityPresalesLoading.value = false
  }
}

const goToOpportunity = (opportunityId) => {
  opportunityPresalesVisible.value = false
  router.push({ path: '/opportunities', query: { opportunity_id: opportunityId } })
}

// 从客户详情抽屉跳转到商机管理，按当前客户名称过滤，便于在商机上设置售前
const goToOpportunityFromDetail = () => {
  router.push({ path: '/opportunities', query: { customer_name: detailData.customer?.name } })
}

const loadPoolCustomers = async () => {
  poolLoading.value = true
  try {
    const { data } = await request.get('/api/customers/pool/list', {
      params: { 
        page: poolPagination.page, 
        limit: poolPagination.limit,
        name: poolSearch.value || undefined
      }
    })
    
    console.log('公海客户响应:', data)
    poolData.value = data.data
    poolPagination.total = data.pagination.total
  } catch (error) {
    console.error('加载公海客户失败:', error)
    console.error('错误详情:', error.response?.data)
    console.error('错误状态码:', error.response?.status)
    
    const errorMsg = error.response?.data?.error || 
                     error.message || 
                     '加载公海客户失败'
    ElMessage.error(errorMsg)
  } finally {
    poolLoading.value = false
  }
}

const onPoolSearch = () => {
  poolPagination.page = 1
  loadPoolCustomers()
}

const resetFilters = () => {
  filters.name = ''
  filters.type = ''
  filters.status = []
  filters.level = ''
  pagination.page = 1
  loadData()
}

// 客户类型变化时，加载渠道列表
const handleCustomerTypeChange = (val) => {
  customerForm.channel_id = ''
  customerForm.channel_name = ''
  if (val === 'external_channel' || val === 'company_channel') {
    loadChannels()
  }
}

// 加载渠道列表
const loadChannels = async () => {
  try {
    const { data } = await request.get('/api/channels/my')
    channelOptions.value = data?.data || []
  } catch (e) {
    console.error('加载渠道列表失败:', e)
  }
}

// 渠道选择变化
const handleChannelChange = (channelId) => {
  const ch = channelOptions.value.find(c => c.id === channelId)
  customerForm.channel_name = ch ? ch.name : ''
}

const showAddDialog = () => {
  isEdit.value = false
  Object.assign(customerForm, {
    id: '',
    name: '',
    customer_short_name: '',
    type: '',
    channel_name: '',
    channel_id: '',
    credit_code: '',
    industry: '',
    scale: '',
    region: [],
    address: '',
    website: '',
    company_phone: '',
    contact_person: '',
    phone: '',
    source: '',
    level: '',
    tag_ids: [],
    owner_id: null,
    notes: '',
    internal_notes: ''
  })
  dialogVisible.value = true
}

const editCustomer = async (row) => {
  isEdit.value = true
  // 先加载渠道列表
  await loadChannels()
  // 将地区字符串转换为数组
  let regionArray = []
  if (row.region) {
    regionArray = row.region.split('/')
  }
  
  Object.assign(customerForm, {
    id: row.id,
    name: row.name,
    customer_short_name: row.customer_short_name,
    type: row.type,
    channel_name: row.channel_name || '',
    channel_id: row.channel_id || '',
    credit_code: row.credit_code,
    industry: row.industry,
    scale: row.scale,
    region: regionArray,
    address: row.address,
    website: row.website,
    company_phone: row.company_phone,
    contact_person: row.contact_person,
    phone: row.phone,
    source: row.source,
    level: row.level,
    tag_ids: (row.tags || [])
      .map(tName => {
        const tag = tagList.value.find(t => t.name === tName)
        return tag ? tag.id : null
      })
      .filter(id => id !== null),
    owner_id: row.owner_id,
    notes: row.notes,
    internal_notes: row.internal_notes
  })
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return
  
  await formRef.value.validate(async (valid) => {
    if (!valid) {
      ElMessage.error('请检查表单填写是否完整')
      console.error('表单验证失败，请检查必填字段')
      return
    }
    
    submitting.value = true
    try {
      // 将地区数组转换为字符串
      const submitData = { ...customerForm }
      if (Array.isArray(submitData.region) && submitData.region.length > 0) {
        submitData.region = submitData.region.join('/')
      } else if (Array.isArray(submitData.region)) {
        submitData.region = ''
      }

      if (submitData.channel_id) {
        const channel = channelOptions.value.find(item => item.id === submitData.channel_id)
        submitData.channel_name = submitData.channel_name || channel?.name || ''
      } else {
        submitData.channel_id = null
        submitData.channel_name = ''
      }

      submitData.tag_ids = Array.isArray(submitData.tag_ids) ? submitData.tag_ids.filter(Boolean) : []
      submitData.owner_id = submitData.owner_id || null
      
      console.log('提交客户数据:', submitData)
      
      if (isEdit.value) {
        await request.put(`/api/customers/${customerForm.id}`, submitData)
        ElMessage.success('更新成功')
      } else {
        const response = await request.post('/api/customers', submitData)
        console.log('服务器响应:', response)
        ElMessage.success('创建成功')
      }
      dialogVisible.value = false
      loadData()
    } catch (error) {
      console.error('客户创建/更新失败:', error)
      console.error('错误详情:', error.response?.data)
      
      // 显示详细错误信息
      const errorMsg = error.response?.data?.error || 
                       error.message || 
                       '操作失败'
      
      if (error.response?.status === 401) {
        ElMessage.error('登录已过期，请重新登录')
      } else if (error.response?.status === 400) {
        ElMessage.error(`数据验证失败：${errorMsg}`)
      } else if (error.response?.status === 500) {
        ElMessage.error(errorMsg)
      } else {
        ElMessage.error(errorMsg)
      }
    } finally {
      submitting.value = false
    }
  })
}

const viewDetail = async (id) => {
  try {
    const { data } = await request.get(`/api/customers/${id}`)
    detailData.customer = data.customer
    detailData.contacts = data.contacts
    detailData.followups = data.followups
    detailData.contracts = data.contracts
    detailData.tags = data.tags
    detailData.payments = data.payments || []
    detailData.changeLogs = data.changeLogs || []
    detailData.presalesAssignments = data.presales_assignments || []
    detailData.fdeAssignments = data.fde_assignments || []
    detailVisible.value = true
  } catch (error) {
    ElMessage.error('加载客户详情失败')
  }
}

const handleRowClick = (row) => {
  viewDetail(row.id)
}

const handleCommand = (command, row) => {
  if (command === 'detail') {
    viewDetail(row.id)
  } else if (command === 'edit') {
    editCustomer(row)
  } else if (command === 'assign') {
    assignType.value = 'assign'
    assignForm.customer_id = row.id
    assignForm.owner_id = null
    assignForm.protect_days = 0
    assignDialogVisible.value = true
  } else if (command === 'transfer') {
    assignType.value = 'transfer'
    assignForm.customer_id = row.id
    assignForm.target_owner_id = null
    assignForm.reason = ''
    assignDialogVisible.value = true
  } else if (command === 'public') {
    ElMessageBox.prompt('请输入移入公海的原因', '提示', {
      inputPattern: /.+/,
      inputErrorMessage: '原因不能为空'
    }).then(async ({ value }) => {
      await request.post(`/api/customers/${row.id}/public`, { reason: value })
      ElMessage.success('已移入公海')
      loadData()
    }).catch(() => {})
  } else if (command === 'share') {
    showShareDialog(row.id)
  } else if (command === 'assign-customer-fde') {
    openCustomerFdeDialog(row)
  } else if (command === 'assign-customer-presales') {
    openCustomerPresalesDialog(row)
  } else if (command === 'add-opportunity') {
    showAddOpportunityDialog(row)
  } else if (command === 'add-contact') {
    showAddContactDialog(row)
  } else if (command === 'add-followup') {
    showAddFollowupDialog(row)
  } else if (command === 'add-presales-followup') {
    showAddFollowupDialog(row)
  } else if (command === 'add-contract') {
    showAddContractDialog(row)
  } else if (command === 'add-payment') {
    showAddPaymentDialog(row)
  }
}

const submitAssign = async () => {
  assignSubmitting.value = true
  try {
    if (assignType.value === 'assign') {
      await request.post(`/api/customers/${assignForm.customer_id}/assign`, {
        owner_id: assignForm.owner_id,
        protect_days: assignForm.protect_days
      })
      ElMessage.success('分配成功')
    } else {
      await request.post(`/api/customers/${assignForm.customer_id}/transfer`, {
        target_owner_id: assignForm.target_owner_id,
        reason: assignForm.reason
      })
      ElMessage.success('转移成功')
    }
    assignDialogVisible.value = false
    loadData()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '操作失败')
  } finally {
    assignSubmitting.value = false
  }
}

const showPoolDialog = () => {
  loadPoolCustomers()
  poolDialogVisible.value = true
}

const claimPoolCustomer = async (id) => {
  try {
    // 找到对应的客户，设置 claiming 状态
    const customer = poolData.value.find(c => c.id === id)
    if (customer) {
      customer.claiming = true
    }
    
    await request.post('/api/customers/pool/claim', { customer_ids: [id] })
    ElMessage.success('领取成功')
    loadPoolCustomers()
    loadData()  // 刷新主列表
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '领取失败')
  } finally {
    // 清除 claiming 状态
    const customer = poolData.value.find(c => c.id === id)
    if (customer) {
      customer.claiming = false
    }
  }
}

const exportData = async () => {
  exporting.value = true
  try {
    const response = await request.get('/api/customers/export', {
      params: {
        name: filters.name || undefined,
        type: filters.type || undefined,
        status: filters.status?.length ? filters.status.join(',') : undefined,
        level: filters.level || undefined
      },
      responseType: 'blob'
    })
    downloadBlobResponse(response, `客户数据_${new Date().toISOString().slice(0, 10)}.csv`)
    ElMessage.success('客户数据导出成功')
  } catch (error) {
    ElMessage.error('客户数据导出失败')
  } finally {
    exporting.value = false
  }
}

// 显示共享对话框
const showShareDialog = (customerId) => {
  shareForm.customer_id = customerId
  shareForm.secondary_owner_id = ''
  shareForm.owner_share_percent = 50
  shareDialogVisible.value = true
}

// ==================== 添加商机功能 ====================

// 显示添加商机对话框
const showAddOpportunityDialog = (row) => {


  // 自动带入客户信息
  Object.assign(opportunityForm, {
    id: '',
    name: '',
    customer_id: row.id,
    customer_name: row.name,
    contact_id: '',
    type: '',
    description: '',
    products: '',
    expected_sign_date: '',
    competitors: '',
    amount: 0,
    owner_id: currentUser.role === 'sales' ? currentUser.id : (row.owner_id || ''),
    presales_user_id: row.default_presales_id || '',
    status: 'potential'
  })
  opportunityContactList.value = []
  // 加载该客户的联系人
  loadOpportunityContacts(row.id)
  opportunityDialogVisible.value = true
}

// 加载客户联系人
const loadOpportunityContacts = async (customerId) => {
  try {
    const { data } = await request.get(`/api/opportunities/customers/${customerId}/contacts`)
    opportunityContactList.value = data.contacts || []
  } catch (error) {
    opportunityContactList.value = []
  }
}

// 提交商机
const submitOpportunity = async () => {
  if (!opportunityFormRef.value) return

  await opportunityFormRef.value.validate(async (valid) => {
    if (!valid) {
      ElMessage.error('请检查表单填写是否完整')
      return
    }

    opportunitySubmitting.value = true
    try {
      await request.post('/api/opportunities', opportunityForm)
      ElMessage.success('商机创建成功')
      opportunityDialogVisible.value = false
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message || '操作失败'
      ElMessage.error(errorMsg)
    } finally {
      opportunitySubmitting.value = false
    }
  })
}

// 显示创建联系人对话框（从商机表单）
const showCreateContactFromOpp = () => {
  if (!opportunityForm.customer_id) {
    ElMessage.warning('请先选择客户')
    return
  }
  Object.assign(oppContactForm, {
    customer_id: opportunityForm.customer_id,
    name: '',
    position: '',
    phone: '',
    email: '',
    is_kp: false
  })
  oppContactDialogVisible.value = true
}

// 提交联系人（从商机表单）
const submitOppContact = async () => {
  if (!oppContactFormRef.value) return

  await oppContactFormRef.value.validate(async (valid) => {
    if (!valid) return

    oppContactSubmitting.value = true
    try {
      await request.post('/api/contacts', oppContactForm)
      ElMessage.success('联系人创建成功')
      oppContactDialogVisible.value = false
      // 重新加载联系人列表
      loadOpportunityContacts(opportunityForm.customer_id)
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '创建失败')
    } finally {
      oppContactSubmitting.value = false
    }
  })
}

// ==================== 新增客户联系人 ====================

// 显示新增联系人对话框
const showAddContactDialog = (row) => {
  Object.assign(contactForm, {
    customer_id: row.id,
    customer_name: row.name,
    name: '',
    position: '',
    phone: '',
    email: '',
    wechat: '',
    is_kp: 0,
    birthday: '',
    notes: ''
  })
  contactDialogVisible.value = true
}

// 提交联系人
const submitContact = async () => {
  if (!contactFormRef.value) return

  await contactFormRef.value.validate(async (valid) => {
    if (!valid) return

    const { phone, email, wechat } = contactForm
    if (!phone && !email && !wechat) {
      ElMessage.error('手机、邮箱、微信三者必须至少填写一项')
      return
    }

    contactSubmitting.value = true
    try {
      await request.post('/api/contacts', contactForm)
      ElMessage.success('联系人创建成功')
      contactDialogVisible.value = false
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '创建失败')
    } finally {
      contactSubmitting.value = false
    }
  })
}

// ==================== 新增销售跟进 ====================

// 显示新增跟进对话框
const showAddFollowupDialog = (row) => {
  Object.assign(followupForm, {
    customer_id: row.id,
    customer_name: row.name,
    opportunity_id: '',
    type: '',
    content: '',
    stage: '',
    result: ''
  })
  followupOpportunityList.value = []
  if (!isPresales) loadFollowupOpportunities(row.id)
  followupDialogVisible.value = true
}

// 加载跟进的商机列表
const loadFollowupOpportunities = async (customerId) => {
  try {
    const { data } = await request.get('/api/opportunities', {
      params: { customer_id: customerId, limit: 100 }
    })
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    followupOpportunityList.value = (data.data || []).filter(opp => opp.creator_id === user.id)
  } catch (error) {
    followupOpportunityList.value = []
  }
}

// 提交跟进
const submitFollowup = async () => {
  if (!followupFormRef.value) return

  await followupFormRef.value.validate(async (valid) => {
    if (!valid) return

    followupSubmitting.value = true
    try {
      if (isPresales) {
        await request.post(`/api/customers/${followupForm.customer_id}/presales-followups`, {
          type: followupForm.type,
          content: followupForm.content
        })
      } else {
        await request.post('/api/followups', followupForm)
      }
      ElMessage.success('跟进创建成功')
      followupDialogVisible.value = false
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '创建失败')
    } finally {
      followupSubmitting.value = false
    }
  })
}

// ==================== 新增合同 ====================

// 显示新增合同对话框
const showAddContractDialog = (row) => {
  Object.assign(contractForm, {
    customer_id: row.id,
    customer_name: row.name,
    contact_id: '',
    opportunity_id: '',
    title: '',
    type: '销售合同',
    amount: 0,
    status: 'active',
    sign_date: '',
    effective_date: '',
    expire_date: '',
    payment_method: '',
    payment_times: 1,
    payment_plans: [],
    content: '',
    payment_terms: ''
  })
  contractOpportunityList.value = []
  contractContactList.value = []
  // 加载该客户的商机和联系人
  loadContractOpportunities(row.id)
  loadContractContacts(row.id)
  contractDialogVisible.value = true
}

// 加载合同的商机列表
const loadContractOpportunities = async (customerId) => {
  try {
    const { data } = await request.get('/api/opportunities', {
      params: { customer_id: customerId, limit: 100 }
    })
    const user = JSON.parse(localStorage.getItem('user') || '{}')
    contractOpportunityList.value = (data.data || []).filter(opp => opp.creator_id === user.id)
  } catch (error) {
    contractOpportunityList.value = []
  }
}

// 加载合同的联系人列表
const loadContractContacts = async (customerId) => {
  try {
    const { data } = await request.get('/api/contacts', { params: { customer_id: customerId } })
    contractContactList.value = data.data || []
  } catch (error) {
    contractContactList.value = []
  }
}

// 生成付款计划
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
    const paymentDate = new Date(signDate)
    paymentDate.setFullYear(paymentDate.getFullYear() + 1)
    paymentDate.setMonth(11)
    paymentDate.setDate(31)
    plans.push({
      amount: parseFloat(contractForm.amount.toFixed(2)),
      date: paymentDate.toISOString().split('T')[0]
    })
  }

  contractForm.payment_plans = plans
  ElMessage.success('付款计划已生成，可手动调整')
}

// 删除付款计划
const removeContractPaymentPlan = (index) => {
  contractForm.payment_plans.splice(index, 1)
}

// 提交合同
const submitContract = async () => {
  if (!contractFormRef.value) return

  // 校验付款计划是否已生成
  if (!contractForm.payment_plans || contractForm.payment_plans.length === 0) {
    ElMessage.error('请先生成付款计划')
    return
  }

  await contractFormRef.value.validate(async (valid) => {
    if (!valid) return

    contractSubmitting.value = true
    try {
      const submitData = { ...contractForm }
      if (submitData.sign_date) submitData.sign_date = new Date(submitData.sign_date).toISOString().split('T')[0]
      if (submitData.effective_date) submitData.effective_date = new Date(submitData.effective_date).toISOString().split('T')[0]
      if (submitData.expire_date) submitData.expire_date = new Date(submitData.expire_date).toISOString().split('T')[0]
      if (submitData.payment_plans && Array.isArray(submitData.payment_plans)) {
        submitData.payment_plans = submitData.payment_plans.map(plan => ({
          amount: plan.amount,
          date: plan.date ? new Date(plan.date).toISOString().split('T')[0] : null
        }))
      }
      await request.post('/api/contracts', submitData)
      ElMessage.success('合同创建成功')
      contractDialogVisible.value = false
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '创建失败')
    } finally {
      contractSubmitting.value = false
    }
  })
}

// ==================== 新增回款 ====================

// 显示新增回款对话框
const showAddPaymentDialog = (row) => {
  Object.assign(paymentForm, {
    customer_id: row.id,
    customer_name: row.name,
    contract_id: '',
    amount: 0,
    actual_date: '',
    method: '',
    status: '已回款',
    notes: ''
  })
  paymentContractList.value = []
  // 加载该客户的合同
  loadPaymentContracts(row.id)
  paymentDialogVisible.value = true
}

// 加载回款的合同列表
const loadPaymentContracts = async (customerId) => {
  try {
    const { data } = await request.get('/api/contracts', { params: { customer_id: customerId, limit: 100 } })
    paymentContractList.value = data.data || []
  } catch (error) {
    paymentContractList.value = []
  }
}

// 合同改变时自动填充客户信息
const handlePaymentContractChange = (contractId) => {
  const contract = paymentContractList.value.find(c => c.id === contractId)
  if (contract) {
    paymentForm.customer_id = contract.customer_id
    paymentForm.customer_name = contract.customer_name
  }
}

// 提交回款
const submitPayment = async () => {
  if (!paymentFormRef.value) return

  await paymentFormRef.value.validate(async (valid) => {
    if (!valid) return

    paymentSubmitting.value = true
    try {
      const submitData = { ...paymentForm }
      if (submitData.actual_date) submitData.actual_date = new Date(submitData.actual_date).toISOString().split('T')[0]
      await request.post('/api/payments', submitData)
      ElMessage.success('回款创建成功')
      paymentDialogVisible.value = false
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '创建失败')
    } finally {
      paymentSubmitting.value = false
    }
  })
}

// 提交共享
const submitShare = async () => {
  if (!shareForm.secondary_owner_id) {
    ElMessage.error('请选择要共享的销售')
    return
  }
  
  shareSubmitting.value = true
  try {
    await request.post(`/api/customers/${shareForm.customer_id}/share`, {
      secondary_owner_id: shareForm.secondary_owner_id,
      owner_share_percent: shareForm.owner_share_percent
    })
    ElMessage.success('共享成功')
    shareDialogVisible.value = false
    loadData()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '共享失败')
  } finally {
    shareSubmitting.value = false
  }
}

onMounted(() => {
  loadData()
  loadTags()
  loadSales()
  loadPresales()
  // 检查是否为管理员
  const user = JSON.parse(localStorage.getItem('user') || '{}')
  isAdmin.value = ['admin', 'super_admin'].includes(user.role)
})
</script>

<style scoped>
.customer-list {
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

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
}

.pagination {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border-light);
  display: flex;
  justify-content: flex-end;
}

:deep(.el-divider__text) {
  font-weight: 600;
  font-size: 14px;
  color: var(--color-text-primary);
}

.pool-toolbar {
  margin-bottom: var(--spacing-xl);
}

.pool-toolbar .el-alert {
  margin-bottom: var(--spacing-md);
}

.pool-toolbar p {
  margin: var(--spacing-xs) 0;
  font-size: 13px;
  color: var(--color-text-regular);
}

.pool-pagination {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border-light);
  display: flex;
  justify-content: flex-end;
}

:deep(.customer-dropdown.el-popper) {
  z-index: 3000 !important;
}

.metric-count,
.metric-link {
  display: inline-flex;
  width: 32px;
  height: 28px;
  align-items: center;
  justify-content: center;
  font-weight: 600;
}

.scope-tip {
  margin-bottom: 14px;
}

.unassigned-value,
.field-hint {
  color: var(--color-text-secondary);
}

.field-hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.header-tip-icon {
  margin-left: 4px;
  color: var(--color-text-secondary);
  vertical-align: middle;
  cursor: help;
}

.customer-assignment-cell {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.customer-assignment-actions {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
}

.customer-assignment-tip {
  flex: none;
  color: var(--color-text-secondary);
  font-size: 12px;
}
</style>
