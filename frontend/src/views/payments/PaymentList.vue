<template>
  <div class="payment-list">
    <el-card>
      <div class="filter-bar">
        <el-form :inline="true" :model="filters">
          <el-form-item label="客户名称">
            <el-input v-model="filters.customer_name" placeholder="请输入客户名称" clearable />
          </el-form-item>
          <el-form-item label="合同编号">
            <el-input v-model="filters.contract_no" placeholder="请输入合同编号" clearable />
          </el-form-item>
          <el-form-item label="回款状态">
            <el-select v-model="filters.status" placeholder="全部" clearable style="width: 120px">
              <el-option label="已回款" value="received" />
              <el-option label="待回款" value="pending" />
            </el-select>
          </el-form-item>
          <el-form-item label="回款日期">
            <el-date-picker
              v-model="dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="YYYY-MM-DD"
              style="width: 240px"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="loadData">查询</el-button>
            <el-button @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="toolbar">
        <el-button v-if="canEditPayments" type="primary" @click="showAddDialog">
          <el-icon><Plus /></el-icon>
          新增回款
        </el-button>
        <el-button type="warning" @click="showUpcomingPayments">
          <el-icon><Clock /></el-icon>
          回款提醒
          <el-badge :value="upcomingCount" :hidden="upcomingCount === 0" type="danger" />
        </el-button>
        <el-button type="success" @click="showStats">
          <el-icon><DataAnalysis /></el-icon>
          回款统计
        </el-button>
        <el-button type="danger" @click="showAmountMismatch">
          <el-icon><Warning /></el-icon>
          金额异常
          <el-badge :value="mismatchCount" :hidden="mismatchCount === 0" type="danger" />
        </el-button>
      </div>

      <el-table class="payment-table" :data="tableData" v-loading="loading" stripe>
        <el-table-column prop="customer_name" label="客户" min-width="140" show-overflow-tooltip />
        <el-table-column prop="contract_title" label="合同名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="contract_no" label="合同编号" width="180" show-overflow-tooltip />
        <el-table-column label="合同金额(元)" width="140" align="right" header-align="right">
          <template #default="{ row }">{{ formatLargeNumber(row.contract_amount) }}</template>
        </el-table-column>
        <el-table-column prop="amount" label="回款金额(元)" width="150" align="right" header-align="right">
          <template #default="{ row }">
            <span :class="['payment-amount', { 'is-pending': isPendingPayment(row) }]">
              {{ formatLargeNumber(row.amount) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="actual_date" label="回款日期" width="125" align="center" />
        <el-table-column prop="status" label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="isPendingPayment(row) ? 'warning' : 'success'" size="small" effect="light">
              {{ isPendingPayment(row) ? '待回款' : '已回款' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="method" label="回款方式" width="110" align="center">
          <template #default="{ row }">
            <span v-if="isPendingPayment(row)" class="muted-text">-</span>
            <el-tag v-else size="small" effect="plain">{{ getMethodLabel(row.method) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="creator_name" label="创建人" width="105" align="center">
          <template #default="{ row }">{{ row.creator_name || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="190" align="center" fixed="right">
          <template #default="{ row }">
            <div class="table-actions">
              <el-button link type="primary" :icon="View" @click="viewDetail(row.id)">详情</el-button>
              <el-button v-if="canEditPayments" link type="primary" :icon="EditPen" @click="editPayment(row)">编辑</el-button>
              <!-- 删除按钮：仅管理员/超级管理员可见，且待回款行（付款计划）不支持删除 -->
              <el-button
                v-if="canDeletePayment && !isPendingPayment(row)"
                link
                type="danger"
                :icon="Delete"
                @click="deletePayment(row)"
              >删除</el-button>
            </div>
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

    <!-- 新增/编辑回款对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑回款' : '新增回款'"
      width="800px"
      :close-on-click-modal="false"
    >
      <el-form :model="paymentForm" :rules="rules" ref="formRef" label-width="120px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="合同" prop="contract_id">
              <el-select
                v-model="paymentForm.contract_id"
                placeholder="请选择合同"
                filterable
                style="width: 100%"
                @change="handleContractChange"
              >
                <el-option
                  v-for="contract in contractList"
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
                :max="maxPaymentAmount"
                :precision="2" 
                :step="1000"
                style="width: 100%"
                placeholder="请输入回款金额"
              />
              <div v-if="paymentForm.contract_id && contractInfo.amount > 0" style="font-size: 12px; color: #8f959e; margin-top: 4px;">
                合同金额 {{ contractInfo.amount }} 元，已回款 {{ contractInfo.total_received }} 元，
                <span :style="{ color: contractInfo.remaining < 0.01 ? '#f54a45' : '#34c724' }">
                  剩余可回款 {{ contractInfo.remaining.toFixed(2) }} 元
                </span>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="回款日期" prop="actual_date">
              <el-date-picker
                v-model="paymentForm.actual_date"
                type="date"
                placeholder="选择回款日期"
                value-format="YYYY-MM-DD"
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
              <el-select
                v-model="paymentForm.status"
                placeholder="请选择状态"
                style="width: 100%"
                :disabled="!paymentForm.is_pending_plan"
              >
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
        
        <!-- 从付款计划创建 -->
        <el-divider v-if="paymentPlans.length > 0">付款计划</el-divider>
        <el-alert
          v-if="paymentPlans.length > 0"
          title="可从付款计划创建回款"
          type="info"
          :closable="false"
          style="margin-bottom: 15px"
        />
        <div v-if="paymentPlans.length > 0">
          <div v-for="(plan, index) in paymentPlans" :key="plan.id" 
               style="margin-bottom: 10px; padding: 10px; border: 1px solid #dee0e3; border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <span style="font-weight: bold; color: #3370ff;">第{{ plan.payment_no }}期</span>
              <span style="margin-left: 20px;">金额：{{ formatLargeNumber(plan.payment_amount) }}元</span>
              <span style="margin-left: 20px;">日期：{{ plan.payment_date }}</span>
            </div>
            <el-button 
              v-if="plan.payment_status === 'unpaid'"
              type="primary" 
              size="small"
              @click="createFromPlan(plan)"
            >
              创建回款
            </el-button>
            <el-tag v-else type="success" size="small">已回款</el-tag>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">确定</el-button>
      </template>
    </el-dialog>

    <!-- 回款详情对话框 -->
    <el-dialog
      v-model="detailVisible"
      title="回款详情"
      width="800px"
    >
      <div v-loading="detailLoading">
        <el-tabs>
          <el-tab-pane label="基本信息">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="回款编号">{{ detailData.payment?.payment_no }}</el-descriptions-item>
          <el-descriptions-item label="合同编号">{{ detailData.payment?.contract_no }}</el-descriptions-item>
          <el-descriptions-item label="合同名称" :span="2">{{ detailData.payment?.contract_title }}</el-descriptions-item>
          <el-descriptions-item label="客户">{{ detailData.payment?.customer_name }}</el-descriptions-item>
          <el-descriptions-item label="回款金额(元)">
            <span style="color: #34c724; font-weight: bold; font-size: 16px;">
              {{ formatLargeNumber(detailData.payment?.amount) }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="回款日期">{{ detailData.payment?.actual_date }}</el-descriptions-item>
          <el-descriptions-item label="回款方式">{{ getMethodLabel(detailData.payment?.method) }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="detailData.payment?.status === '已回款' ? 'success' : 'info'" size="small">
              {{ detailData.payment?.status === '已回款' ? '已回款' : detailData.payment?.status }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="创建人">{{ detailData.payment?.creator_name }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ detailData.payment?.notes || '-' }}</el-descriptions-item>
        </el-descriptions>
          </el-tab-pane>
          <el-tab-pane label="变更记录">
            <el-table :data="detailData.changeLogs || []" style="width: 100%" v-if="detailData.changeLogs && detailData.changeLogs.length > 0">
              <el-table-column prop="changed_at" label="变更时间" width="160" />
              <el-table-column prop="changed_by_name" label="变更人" width="100" />
              <el-table-column prop="field_name" label="变更字段" width="120" />
              <el-table-column label="变更前值" min-width="200">
                <template #default="{ row }">
                  <span style="color: #f54a45;">{{ row.old_value || '(空)' }}</span>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-else description="暂无变更记录" :image-size="80" />
          </el-tab-pane>
        </el-tabs>
      </div>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-if="canEditPayments" type="primary" @click="editFromDetail">编辑</el-button>
      </template>
    </el-dialog>

    <!-- 回款提醒对话框 -->
    <el-dialog
      v-model="upcomingVisible"
      title="即将到期回款"
      width="800px"
    >
      <el-table :data="upcomingList" max-height="400">
        <el-table-column prop="contract_no" label="合同编号" width="150" />
        <el-table-column prop="contract_title" label="合同名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="customer_name" label="客户" width="150" />
        <el-table-column prop="payment_no" label="期数" width="80" align="center">
          <template #default="{ row }">
            <el-tag size="small">第{{ row.payment_no }}期</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="payment_amount" label="金额(元)" width="120" align="right">
          <template #default="{ row }">
            {{ formatLargeNumber(row.payment_amount) }}
          </template>
        </el-table-column>
        <el-table-column prop="payment_date" label="计划回款日期" width="120" />
        <el-table-column label="剩余天数" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.days_until_due <= 7 ? 'danger' : 'warning'">
              {{ Math.ceil(row.days_until_due) }}天
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" align="center">
          <template #default="{ row }">
            <el-button v-if="canEditPayments" type="primary" size="small" @click="createFromPlan(row)">收款</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <!-- 回款统计对话框 -->
    <el-dialog
      v-model="statsVisible"
      title="回款统计"
      width="900px"
    >
      <el-alert
        :title="'本年度' + currentYear + '年1月1日至' + currentYear + '年12月31日'"
        type="info"
        :closable="false"
        style="margin-bottom: 15px; font-size: 13px;"
      />
      <el-row :gutter="16" class="stats-summary">
        <el-col :span="6">
          <el-statistic title="已回款笔数" :value="statsData.total_count" />
        </el-col>
        <el-col :span="6">
          <el-statistic title="已回款金额" :value="statsData.total_amount" :precision="0">
            <template #prefix>¥</template>
          </el-statistic>
        </el-col>
        <el-col :span="6">
          <el-statistic title="待回款笔数" :value="statsData.pending_count" />
        </el-col>
        <el-col :span="6">
          <el-statistic title="待回款金额" :value="statsData.pending_amount" :precision="0">
            <template #prefix>¥</template>
          </el-statistic>
        </el-col>
      </el-row>
      <el-divider>按回款方式统计</el-divider>
      <el-table :data="statsData.by_method" size="small">
        <el-table-column prop="method" label="回款方式" width="150">
          <template #default="{ row }">
            {{ getMethodLabel(row.method) }}
          </template>
        </el-table-column>
        <el-table-column prop="count" label="笔数" width="100" align="center" />
        <el-table-column prop="total_amount" label="金额(元)" align="right">
          <template #default="{ row }">
            {{ formatLargeNumber(row.total_amount) }}
          </template>
        </el-table-column>
      </el-table>
      <el-divider>月度回款趋势</el-divider>
      <el-table :data="statsData.by_month" size="small">
        <el-table-column prop="month" label="月份" width="120" />
        <el-table-column prop="count" label="笔数" width="100" align="center" />
        <el-table-column prop="total_amount" label="金额(元)" align="right">
          <template #default="{ row }">
            {{ formatLargeNumber(row.total_amount) }}
          </template>
        </el-table-column>
      </el-table>
      <el-divider>去年数据（{{ lastYear }}年）</el-divider>
      <el-row :gutter="20" style="margin-top: 10px;">
        <el-col :span="12">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="去年已回款笔数">{{ statsData.last_year_received_count }}</el-descriptions-item>
            <el-descriptions-item label="去年已回款金额(元)">
              {{ formatLargeNumber(statsData.last_year_received_amount) }}
            </el-descriptions-item>
          </el-descriptions>
        </el-col>
        <el-col :span="12">
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="去年待回款笔数">{{ statsData.last_year_pending_count }}</el-descriptions-item>
            <el-descriptions-item label="去年待回款金额(元)">
              {{ formatLargeNumber(statsData.last_year_pending_amount) }}
            </el-descriptions-item>
          </el-descriptions>
        </el-col>
      </el-row>
    </el-dialog>

    <!-- 金额异常对话框 -->
    <el-dialog
      v-model="mismatchVisible"
      title="回款金额异常"
      width="900px"
    >
      <el-alert
        v-if="mismatchData.summary.total_unpaid > 0"
        :title="'共发现 ' + mismatchData.total + ' 个合同回款金额异常，累计少收 ¥' + formatLargeNumber(mismatchData.summary.total_unpaid) + ' 元'"
        type="warning"
        :closable="false"
        style="margin-bottom: 15px"
      />
      <el-alert
        v-if="mismatchData.summary.total_overpaid < 0"
        :title="'累计超额 ¥' + formatLargeNumber(Math.abs(mismatchData.summary.total_overpaid)) + ' 元'"
        type="info"
        :closable="false"
        style="margin-bottom: 15px"
      />
      <el-empty v-if="mismatchData.total === 0" description="暂无回款金额异常" :image-size="80" />
      <el-table v-else :data="mismatchData.data" max-height="400" size="small">
        <el-table-column label="合同编号" width="160">
          <template #default="{ row }">
            <el-link type="primary" @click="showContractPayments(row)">{{ row.contract_no }}</el-link>
          </template>
        </el-table-column>
        <el-table-column prop="contract_title" label="合同名称" min-width="150" show-overflow-tooltip />
        <el-table-column prop="customer_name" label="客户" width="120" />
        <el-table-column label="合同金额" width="120" align="right">
          <template #default="{ row }">{{ formatLargeNumber(row.contract_amount) }}</template>
        </el-table-column>
        <el-table-column label="已回款" width="120" align="right">
          <template #default="{ row }">{{ formatLargeNumber(row.total_received) }}</template>
        </el-table-column>
        <el-table-column label="差额" width="120" align="right">
          <template #default="{ row }">
            <span :style="{ color: row.diff > 0 ? '#f54a45' : '#34c724', fontWeight: 'bold' }">
              {{ row.diff > 0 ? '-' : '+' }}{{ formatLargeNumber(Math.abs(row.diff)) }}
            </span>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <!-- 合同回款详情对话框 -->
    <el-dialog
      v-model="contractDetailVisible"
      :title="'合同回款详情 - ' + contractDetail.contract_no"
      width="800px"
    >
      <el-descriptions :column="2" border style="margin-bottom: 15px">
        <el-descriptions-item label="合同编号">{{ contractDetail.contract_no }}</el-descriptions-item>
        <el-descriptions-item label="合同名称">{{ contractDetail.contract_title }}</el-descriptions-item>
        <el-descriptions-item label="客户">{{ contractDetail.customer_name }}</el-descriptions-item>
        <el-descriptions-item label="合同金额">{{ formatLargeNumber(contractDetail.contract_amount) }} 元</el-descriptions-item>
        <el-descriptions-item label="已回款">{{ formatLargeNumber(contractDetail.total_received) }} 元</el-descriptions-item>
        <el-descriptions-item label="差额">
          <span :style="{ color: contractDetail.diff > 0 ? '#f54a45' : '#34c724', fontWeight: 'bold' }">
            {{ contractDetail.diff > 0 ? '-' : '+' }}{{ formatLargeNumber(Math.abs(contractDetail.diff)) }} 元
          </span>
        </el-descriptions-item>
      </el-descriptions>

      <el-divider>付款计划</el-divider>
      <el-table :data="contractDetail.plans" size="small" max-height="200">
        <el-table-column label="期数" width="80" align="center">
          <template #default="{ row }">第{{ row.payment_no }}期</template>
        </el-table-column>
        <el-table-column prop="payment_date" label="计划日期" width="120" />
        <el-table-column label="计划金额" width="120" align="right">
          <template #default="{ row }">{{ formatLargeNumber(row.payment_amount) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.payment_status === 'paid' ? 'success' : 'info'" size="small">
              {{ row.payment_status === 'paid' ? '已回' : '待回' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="实际金额" width="120" align="right">
          <template #default="{ row }">{{ row.actual_amount ? formatLargeNumber(row.actual_amount) : '-' }}</template>
        </el-table-column>
        <el-table-column prop="actual_payment_date" label="实际日期" width="120" />
      </el-table>

      <el-divider>实际回款记录</el-divider>
      <el-empty v-if="contractDetail.payments.length === 0" description="暂无回款记录" :image-size="60" />
      <el-table v-else :data="contractDetail.payments" size="small" max-height="200">
        <el-table-column prop="payment_no" label="回款编号" width="160" />
        <el-table-column label="回款金额" width="120" align="right">
          <template #default="{ row }">{{ formatLargeNumber(row.amount) }}</template>
        </el-table-column>
        <el-table-column prop="actual_date" label="回款日期" width="120" />
        <el-table-column label="回款方式" width="100">
          <template #default="{ row }">{{ getMethodLabel(row.method) }}</template>
        </el-table-column>
        <el-table-column prop="notes" label="备注" min-width="120" show-overflow-tooltip />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Clock, DataAnalysis, Warning, View, EditPen, Delete } from '@element-plus/icons-vue'
import request from '@/utils/request'

const route = useRoute()

const currentYear = computed(() => new Date().getFullYear())
const lastYear = computed(() => new Date().getFullYear() - 1)
const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
const canEditPayments = currentUser.role !== 'operations'
// 删除回款权限：仅管理员（admin）与超级管理员（super_admin）可见删除按钮
const canDeletePayment = ['admin', 'super_admin'].includes(currentUser.role)

const loading = ref(false)
const submitting = ref(false)
const detailLoading = ref(false)
const dialogVisible = ref(false)
const detailVisible = ref(false)
const upcomingVisible = ref(false)
const statsVisible = ref(false)
const mismatchVisible = ref(false)
const mismatchData = ref({ data: [], total: 0, summary: { total_unpaid: 0, total_overpaid: 0 } })
const mismatchCount = ref(0)

// 合同回款详情
const contractDetailVisible = ref(false)
const contractDetail = ref({
  contract_no: '', contract_title: '', customer_name: '',
  contract_amount: 0, total_received: 0, diff: 0,
  plans: [], payments: []
})
const isEdit = ref(false)
const formRef = ref(null)

const filters = reactive({ customer_name: '', contract_no: '', status: 'pending' })
const dateRange = ref([])
const tableData = ref([])
const contractList = ref([])
const paymentPlans = ref([])
const upcomingList = ref([])
const upcomingCount = ref(0)
const pagination = reactive({ page: 1, limit: 10, total: 0 })

const paymentForm = reactive({
  id: '', contract_id: '', customer_id: '', customer_name: '', 
  amount: 0, original_amount: 0, actual_date: '', method: '', status: 'received', notes: '',
  payment_plan_id: '', is_pending_plan: false
})

// 合同金额信息（选择合同后填充）
const contractInfo = ref({ amount: 0, total_received: 0, remaining: 0 })
const maxPaymentAmount = computed(() => {
  if (!paymentForm.contract_id || contractInfo.value.amount <= 0) return undefined
  if (isEdit.value && !paymentForm.is_pending_plan) {
    return contractInfo.value.remaining + Number(paymentForm.original_amount || 0)
  }
  return contractInfo.value.remaining
})

const detailData = ref({})
const emptyStats = () => ({
  total_count: 0,
  total_amount: 0,
  pending_count: 0,
  pending_amount: 0,
  by_method: [],
  by_month: [],
  last_year_received_count: 0,
  last_year_received_amount: 0,
  last_year_pending_count: 0,
  last_year_pending_amount: 0
})
const statsData = ref(emptyStats())

const rules = {
  contract_id: [{ required: true, message: '请选择合同', trigger: 'change' }],
  amount: [{ required: true, message: '请输入回款金额', trigger: 'blur' }],
  actual_date: [{ required: true, message: '请选择回款日期', trigger: 'change' }]
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

const isPendingPayment = (payment) => ['pending', '待回款', 'unpaid'].includes(payment?.status)

// 格式化大数字，直接显示完整数值
const formatLargeNumber = (num) => {
  num = num || 0
  // 直接显示完整数值，使用千分位分隔符
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

const loadData = async () => {
  loading.value = true
  try {
    const params = {
      page: pagination.page,
      limit: pagination.limit,
      ...filters
    }
    if (dateRange.value && dateRange.value.length === 2) {
      params.start_date = dateRange.value[0]
      params.end_date = dateRange.value[1]
    }
    const { data } = await request.get('/api/payments', { params })
    tableData.value = data.data
    pagination.total = data.pagination.total
  } catch (error) {
    ElMessage.error('加载回款列表失败')
  } finally {
    loading.value = false
  }
}

const loadContracts = async () => {
  try {
    const { data } = await request.get('/api/contracts', { params: { limit: 100 } })
    contractList.value = data.data || []
  } catch (error) {
    contractList.value = []
  }
}

const loadUpcomingPayments = async () => {
  try {
    const { data } = await request.get('/api/payments/upcoming', { params: { days: 30 } })
    upcomingList.value = data.data
    upcomingCount.value = data.total
  } catch (error) {
    upcomingList.value = []
    upcomingCount.value = 0
  }
}

const loadStats = async () => {
  try {
    const { data } = await request.get('/api/payments/stats/overview')
    statsData.value = data
  } catch (error) {
    statsData.value = emptyStats()
  }
}

const showAddDialog = () => {
  isEdit.value = false
  Object.assign(paymentForm, {
    id: '', contract_id: '', customer_id: '', customer_name: '',
    amount: 0, original_amount: 0, actual_date: '', method: '', status: 'received', notes: '',
    payment_plan_id: '', is_pending_plan: false
  })
  contractInfo.value = { amount: 0, total_received: 0, remaining: 0 }
  paymentPlans.value = []
  loadContracts()
  dialogVisible.value = true
}

const handleContractChange = async (contractId) => {
  // 编辑模式下不清空 payment_plan_id / is_pending_plan，否则待回款编辑提交时会走错分支
  if (!isEdit.value) {
    paymentForm.customer_id = ''
    paymentForm.customer_name = ''
    paymentPlans.value = []
    paymentForm.payment_plan_id = ''
    paymentForm.is_pending_plan = false
  }
  
  const contract = contractList.value.find(c => c.id === contractId)
  if (contract) {
    paymentForm.customer_id = contract.customer_id
    paymentForm.customer_name = contract.customer_name
    
    // 加载该合同的付款计划
    try {
      const { data } = await request.get(`/api/contracts/${contractId}`)
      if (data.contract && data.contract.payment_plans) {
        paymentPlans.value = data.contract.payment_plans
      }
      // 填充合同金额信息
      const c = data.contract
      contractInfo.value = {
        amount: c.amount || 0,
        total_received: c.total_received || 0,
        remaining: Math.max(0, (c.amount || 0) - (c.total_received || 0))
      }
    } catch (error) {
      console.error('加载合同信息失败', error)
    }
  }
}

const createFromPlan = async (plan) => {
  isEdit.value = true

  // 确保合同列表已加载，el-select 才能显示名称
  if (!contractList.value.length) {
    await loadContracts()
    await nextTick()
  }

  if (dialogVisible.value) {
    // 对话框已打开，用户已选了合同，保留不覆盖
    // 只更新金额、日期等字段
    paymentForm.id = ''
    paymentForm.amount = plan.payment_amount
    paymentForm.original_amount = 0
    paymentForm.actual_date = plan.payment_date
    paymentForm.method = ''
    paymentForm.notes = `第${plan.payment_no}期回款`
    paymentForm.payment_plan_id = plan.id
    paymentForm.is_pending_plan = true
    paymentForm.status = 'received'
  } else {
    // 从回款提醒等场景进入，需要设置完整字段
    Object.assign(paymentForm, {
      id: '',
      contract_id: plan.contract_id,
      customer_id: plan.customer_id || '',
      customer_name: plan.customer_name || '',
      amount: plan.payment_amount,
      original_amount: 0,
      actual_date: plan.payment_date,
      method: '',
      status: 'received',
      notes: `第${plan.payment_no}期回款`,
      payment_plan_id: plan.id,
      is_pending_plan: true
    })
  }
  dialogVisible.value = true
}

const editPayment = async (row) => {
  isEdit.value = true
  // 兼容后端返回的 '已回款' 和前端的 'pending'
  const isPendingPlan = row.status === 'pending' || row.status === '待回款'
  Object.assign(paymentForm, {
    id: row.id,
    contract_id: row.contract_id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    amount: row.amount,
    original_amount: isPendingPlan ? 0 : Number(row.amount || 0),
    actual_date: row.actual_date,
    method: row.method || '',
    status: isPendingPlan ? 'pending' : 'received',
    notes: row.notes || '',
    payment_plan_id: isPendingPlan ? row.id : '',
    is_pending_plan: isPendingPlan
  })
  
  // 加载合同信息
  if (row.contract_id) {
    try {
      const { data } = await request.get(`/api/contracts/${row.contract_id}`)
      if (data.contract) {
        const c = data.contract
        contractInfo.value = {
          amount: c.amount || 0,
          total_received: c.total_received || 0,
          remaining: Math.max(0, (c.amount || 0) - (c.total_received || 0))
        }
      }
    } catch (error) {
      console.error('加载合同详情失败', error)
    }
  }
  
  loadContracts()
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const submitData = { ...paymentForm }
    // 编辑待回款记录且状态改为已回款 → 更新付款计划并创建实际回款
    if (paymentForm.is_pending_plan && (paymentForm.status === '已回款' || paymentForm.status === 'received')) {
      await request.put(`/api/payments/plan/${paymentForm.payment_plan_id}`, {
        payment_date: submitData.actual_date,
        payment_amount: submitData.amount,
        status: '已回款',
        actual_date: submitData.actual_date,
        method: submitData.method,
        notes: submitData.notes
      })
      ElMessage.success('已回款，已创建回款记录并更新付款计划')
    } else if (isEdit.value && paymentForm.is_pending_plan) {
      // 编辑待回款记录但状态仍为待回款 → 更新付款计划
      await request.put(`/api/payments/plan/${paymentForm.payment_plan_id}`, {
        payment_date: submitData.actual_date,
        payment_amount: submitData.amount
      })
      ElMessage.success('更新成功')
    } else if (isEdit.value) {
      await request.put(`/api/payments/${paymentForm.id}`, submitData)
      ElMessage.success('更新成功')
    } else {
      await request.post('/api/payments', submitData)
      ElMessage.success('创建成功')
    }
    dialogVisible.value = false
    await refreshAllData()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '操作失败')
  } finally {
    submitting.value = false
  }
}

const viewDetail = async (id) => {
  detailLoading.value = true
  try {
    const { data } = await request.get(`/api/payments/${id}`)
    detailData.value = data
    detailVisible.value = true
  } catch (error) {
    ElMessage.error('加载详情失败')
  } finally {
    detailLoading.value = false
  }
}

const editFromDetail = () => {
  if (!detailData.value.payment) return
  detailVisible.value = false
  editPayment(detailData.value.payment)
}

// 删除回款记录（仅管理员/超级管理员）
const deletePayment = async (row) => {
  try {
    await ElMessageBox.confirm(
      `确定删除【${row.customer_name || '-'}】合同 ${row.contract_no || '-'} 的回款 ${formatLargeNumber(row.amount)} 元（回款日期 ${row.actual_date || '-'}）吗？`
      + '删除后不可恢复，合同已回款金额将同步回退，对应付款计划会退回「待回款」。',
      '删除回款确认',
      {
        type: 'warning',
        confirmButtonText: '确定删除',
        cancelButtonText: '取消'
      }
    )
  } catch {
    return // 用户取消
  }

  try {
    await request.delete(`/api/payments/${row.id}`)
    ElMessage.success('回款记录删除成功')
    await refreshAllData()
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '删除失败')
  }
}

const showUpcomingPayments = () => {
  loadUpcomingPayments()
  upcomingVisible.value = true
}

const showStats = () => {
  loadStats()
  statsVisible.value = true
}

const showAmountMismatch = () => {
  loadAmountMismatch()
  mismatchVisible.value = true
}

const loadAmountMismatch = async () => {
  try {
    const { data } = await request.get('/api/payments/stats/amount-mismatch')
    mismatchData.value = data
    mismatchCount.value = data.total || 0
  } catch (error) {
    console.error('加载金额异常数据失败', error)
    mismatchData.value = { data: [], total: 0, summary: { total_unpaid: 0, total_overpaid: 0 } }
    mismatchCount.value = 0
  }
}

const showContractPayments = async (row) => {
  contractDetail.value = {
    contract_no: row.contract_no,
    contract_title: row.contract_title,
    customer_name: row.customer_name,
    contract_amount: row.contract_amount,
    total_received: row.total_received,
    diff: row.diff,
    plans: [],
    payments: []
  }

  try {
    // 加载付款计划
    const { data: contractData } = await request.get(`/api/contracts/${row.contract_id}`)
    if (contractData.contract) {
      contractDetail.value.plans = contractData.contract.payment_plans || []
    }
  } catch (error) {
    console.error('加载付款计划失败', error)
  }

  try {
    // 加载实际回款记录
    const { data: paymentsData } = await request.get('/api/payments', {
      params: { contract_id: row.contract_id, limit: 100 }
    })
    contractDetail.value.payments = paymentsData.data || []
  } catch (error) {
    console.error('加载回款记录失败', error)
  }

  contractDetailVisible.value = true
}

const refreshAllData = async () => {
  // 并行刷新：当前列表 + 回款提醒 + 回款统计 + 金额异常
  await Promise.allSettled([loadData(), loadUpcomingPayments(), loadStats(), loadAmountMismatch()])
}

const resetFilters = () => {
  Object.assign(filters, { customer_name: '', contract_no: '', status: 'pending' })
  dateRange.value = []
  loadData()
}

onMounted(() => {
  // 支持从 URL query 初始化筛选（数据概览点击跳转时使用）
  if (route.query.status) filters.status = String(route.query.status)
  if (route.query.start_date && route.query.end_date) {
    dateRange.value = [String(route.query.start_date), String(route.query.end_date)]
  }
  loadData()
  loadUpcomingPayments()
  loadAmountMismatch()
})
</script>

<style scoped>
.payment-list {
  padding: 0;
}

.payment-table {
  width: 100%;
}

.payment-table :deep(.el-table__cell) {
  vertical-align: middle;
}

.payment-table :deep(.cell) {
  line-height: 22px;
}

.payment-table :deep(td.el-table-fixed-column--right),
.payment-table :deep(th.el-table-fixed-column--right) {
  box-shadow: -6px 0 12px rgb(31 45 61 / 4%);
}

.payment-amount {
  color: var(--el-color-success);
  font-weight: 600;
  white-space: nowrap;
}

.payment-amount.is-pending {
  color: var(--el-color-warning);
}

.muted-text {
  color: var(--el-text-color-placeholder);
}

.table-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 32px;
  white-space: nowrap;
}

.table-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.stats-summary :deep(.el-col) {
  display: flex;
  justify-content: center;
}

.stats-summary :deep(.el-statistic) {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
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
</style>
