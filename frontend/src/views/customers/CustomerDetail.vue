<template>
  <div class="customer-detail">
    <el-card>
      <template #header>
        <div class="header">
          <el-button @click="$router.back()">
            <el-icon><ArrowLeft /></el-icon>
            返回
          </el-button>
          <h2>{{ customer?.name || '客户详情' }}</h2>
          <el-button 
            v-if="isOwner" 
            type="primary" 
            size="small"
            @click="showShareDialog"
          >
            <el-icon><Share /></el-icon>
            {{ customer?.secondary_owner_name ? '修改共享' : '共享客户' }}
          </el-button>
          <el-button 
            v-if="isOwner && customer?.secondary_owner_name" 
            type="danger" 
            size="small"
            @click="cancelShare"
          >
            取消共享
          </el-button>
        </div>
      </template>
      
      <el-descriptions :column="2" border>
        <el-descriptions-item label="客户类型">
          {{ customer?.type === 'enterprise' ? '企业客户' : '个人客户' }}
        </el-descriptions-item>
        <el-descriptions-item label="客户状态">
          <el-tag>{{ customer?.status }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="主销售">{{ customer?.owner_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="副销售">
          <span v-if="customer?.secondary_owner_name">{{ customer?.secondary_owner_name }}</span>
          <el-tag v-else type="info" size="small">未共享</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="客户等级">{{ customer?.level }}</el-descriptions-item>
        <el-descriptions-item label="联系电话">{{ customer?.phone }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ customer?.created_at }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card class="mt-4">
      <template #header>销售跟进</template>
      <el-table :data="followups" style="width: 100%" v-loading="loading">
        <el-table-column prop="followup_time_formatted" label="跟进时间" width="180" />
        <el-table-column prop="type" label="方式" width="80">
          <template #default="{ row }">
            <el-tag size="small">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="content" label="跟进内容" min-width="200">
          <template #default="{ row }">
            <div class="followup-content-cell">{{ row.content }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="stage" label="阶段" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ getFollowupStageLabel(row.stage) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="result" label="结果" width="100">
          <template #default="{ row }">
            <el-tag :type="row.result === 'success' ? 'success' : 'info'" size="small">{{ row.result || '-' }}</el-tag>
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
        <el-table-column prop="opportunity_name" label="关联商机" min-width="120" show-overflow-tooltip />
      </el-table>
      <div v-if="!followups || followups.length === 0" style="text-align: center; padding: 20px; color: #8f959e;">
        暂无跟进记录
      </div>
    </el-card>

    <el-card class="mt-4">
      <template #header>联系人</template>
      <el-table :data="contacts" style="width: 100%">
        <el-table-column prop="name" label="姓名" />
        <el-table-column prop="position" label="职位" />
        <el-table-column prop="phone" label="电话" />
        <el-table-column prop="email" label="邮箱" />
      </el-table>
    </el-card>

    <el-card class="mt-4">
      <template #header>商机信息</template>
      <el-table :data="opportunities" style="width: 100%" v-loading="loading">
        <el-table-column prop="name" label="商机名称" min-width="150" show-overflow-tooltip />
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            {{ getOppTypeLabel(row.type) }}
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'signed' ? 'success' : 'info'" size="small">
              {{ getOppStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="amount" label="金额" width="120" align="right">
          <template #default="{ row }">
            <span style="color: #34c724; font-weight: bold; white-space: nowrap;">
              ¥{{ (row.amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}元
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="expected_sign_date" label="预计签约日期" width="130" />
        <el-table-column prop="created_at" label="创建时间" width="160" />
      </el-table>
      <div v-if="!opportunities || opportunities.length === 0" style="text-align: center; padding: 20px; color: #8f959e;">
        暂无商机信息
      </div>
    </el-card>

    <el-card class="mt-4">
      <template #header>回款记录</template>
      <el-table :data="payments" style="width: 100%" v-loading="loading">
        <el-table-column prop="payment_no" label="回款编号" width="150" />
        <el-table-column prop="contract_no" label="合同编号" width="150" />
        <el-table-column prop="contract_title" label="合同名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="amount" label="回款金额" width="120" align="right">
          <template #default="{ row }">
            <span style="color: #34c724; font-weight: bold; white-space: nowrap;">
              ¥{{ (row.amount || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) }}元
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
      <div v-if="!payments || payments.length === 0" style="text-align: center; padding: 20px; color: #8f959e;">
        暂无回款记录
      </div>
    </el-card>

    <!-- 共享客户对话框 -->
    <el-dialog
      v-model="shareDialogVisible"
      :title="customer?.secondary_owner_name ? '修改共享' : '共享客户'"
      width="500px"
    >
      <el-form :model="shareForm" label-width="100px">
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
              :disabled="sales.id === customer?.owner_id || sales.id === customer?.secondary_owner_id"
            />
          </el-select>
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
        >
          <p>副销售可以查看客户详情、创建商机，但不能编辑客户信息。</p>
          <p>每个客户最多支持两个销售同时跟进。</p>
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="shareDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitShare" :loading="shareSubmitting">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import axios from 'axios'

const route = useRoute()
const customer = ref(null)
const contacts = ref([])
const followups = ref([])
const opportunities = ref([])
const payments = ref([])
const loading = ref(false)
const salesList = ref([])
const shareDialogVisible = ref(false)
const shareSubmitting = ref(false)
const shareForm = ref({
  secondary_owner_id: ''
})

// 检查当前用户是否为客户主销售
const isOwner = computed(() => {
  const user = JSON.parse(localStorage.getItem('user') || '{}')
  return user.id === customer.value?.owner_id
})

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

const getOppTypeLabel = (type) => {
  const map = {
    new_project: '新项目',
    renewal: '续签',
    maintenance: '维保',
    other: '其他'
  }
  return map[type] || type || '-'
}

const getOppStatusLabel = (status) => {
  const map = {
    potential: '潜在',
    technical: '技术交流',
    poc: 'POC',
    project: '立项',
    bidding: '招投标',
    contracting: '合同中',
    signed: '已签'
  }
  return map[status] || status || '-'
}

const getFollowupStageLabel = (stage) => {
  const map = {
    potential: '潜在客户',
    technical: '技术交流',
    poc: 'POC',
    project: '立项',
    bidding: '招投标',
    contracting: '合同中',
    signed: '已签'
  }
  return map[stage] || stage || '-'
}

onMounted(async () => {
  loading.value = true
  try {
    const { data } = await axios.get(`/api/customers/${route.params.id}`)
    customer.value = data.customer
    contacts.value = data.contacts || []
    followups.value = data.followups || []
    opportunities.value = data.opportunities || []
    payments.value = data.payments || []
    
    // 加载销售列表
    const salesRes = await axios.get('/api/users', { params: { limit: 100, role: 'sales' } })
    salesList.value = salesRes.data.data || []
  } catch (error) {
    console.error('加载客户详情失败:', error)
  } finally {
    loading.value = false
  }
})

// 显示共享对话框
const showShareDialog = () => {
  shareForm.value.secondary_owner_id = customer.value?.secondary_owner_id || ''
  shareDialogVisible.value = true
}

// 提交共享
const submitShare = async () => {
  if (!shareForm.value.secondary_owner_id) {
    ElMessage.error('请选择要共享的销售')
    return
  }
  
  shareSubmitting.value = true
  try {
    await axios.post(`/api/customers/${route.params.id}/share`, {
      secondary_owner_id: shareForm.value.secondary_owner_id
    })
    ElMessage.success('共享成功')
    shareDialogVisible.value = false
    // 重新加载客户详情
    const { data } = await axios.get(`/api/customers/${route.params.id}`)
    customer.value = data.customer
  } catch (error) {
    ElMessage.error(error.response?.data?.error || '共享失败')
  } finally {
    shareSubmitting.value = false
  }
}

// 取消共享
const cancelShare = () => {
  ElMessageBox.confirm('确定要取消共享吗？取消后副销售将无法继续跟进该客户。', '提示', {
    type: 'warning'
  }).then(async () => {
    try {
      await axios.post(`/api/customers/${route.params.id}/unshare`)
      ElMessage.success('取消共享成功')
      // 重新加载客户详情
      const { data } = await axios.get(`/api/customers/${route.params.id}`)
      customer.value = data.customer
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '取消共享失败')
    }
  }).catch(() => {})
}
</script>

<style scoped>
.customer-detail {
  padding: 10px;
}

.header {
  display: flex;
  align-items: center;
  gap: 20px;
}

.mt-4 {
  margin-top: 20px;
}


.followup-content-cell {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
  max-height: 80px;
  overflow-y: auto;
  padding: 4px 0;
}
</style>
