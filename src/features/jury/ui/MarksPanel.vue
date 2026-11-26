<script setup lang="ts">
import { computed } from 'vue'
import { AlertTriangle, Check, Flag, HelpCircle, MapPin, ShieldAlert } from 'lucide-vue-next'
import type { Gate, RoundingAttempt } from '../../../shared/race'
import { netAngleSeries } from '../lib/rounding'

const props = defineProps<{
  gates: Gate[]
  nextGate: number
  penalty: number
  strict: boolean
  requiredAngle: number
  configLocked?: boolean
  attempt?: RoundingAttempt | null
}>()

const emit = defineEmits<{
  toggleStrict: [value: boolean]
  setRequiredAngle: [value: number]
}>()

const statusText: Record<RoundingAttempt['status'], string> = {
  tracking: '绕行追踪中',
  valid: '有效 · 已确认',
  invalid: '擦碰 · 失效',
  unconfirmed: '未确认尝试',
  abandoned: '尝试已中止',
}

const net = computed(() => props.attempt ? Math.round(props.attempt.netAngle) : 0)
const progress = computed(() => props.attempt ? Math.max(0, Math.min(100, props.attempt.netAngle / props.attempt.requiredAngle * 100)) : 0)
const clearance = computed(() => {
  if (!props.attempt || props.attempt.minClearance > 9000) return null
  return props.attempt.minClearance
})

const sparkline = computed(() => {
  const attempt = props.attempt
  if (!attempt || attempt.track.length < 2) return null
  const width = 238, height = 48, pad = 5
  const series = netAngleSeries(attempt.track, attempt.center, attempt.direction)
  const values = series.map(item => item.net)
  const max = Math.max(attempt.requiredAngle, ...values, 10)
  const min = Math.min(0, ...values)
  const span = Math.max(1, max - min)
  const x = (index: number) => pad + index / Math.max(1, series.length - 1) * (width - pad * 2)
  const y = (value: number) => pad + (max - value) / span * (height - pad * 2)
  const line = series.map((item, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(item.net).toFixed(1)}`).join('')
  return {
    width, height, line,
    zeroY: y(0),
    targetY: y(attempt.requiredAngle),
    area: `${line}L${x(series.length - 1).toFixed(1)},${(height - pad).toFixed(1)}L${pad},${(height - pad).toFixed(1)}Z`,
  }
})
</script>

<template>
  <section class="instrument marks" aria-label="绕标裁判">
    <h2><Flag :size="17"/> 绕标裁判 <b data-testid="marks-count">{{ nextGate }} / {{ gates.length }}</b></h2>

    <div class="rule-controls">
      <div class="mode-setting">
        <span>赛制</span>
        <div class="segment" role="group" aria-label="赛制选择" data-testid="strict-toggle">
          <button
            type="button"
            data-testid="classic-mode"
            :aria-pressed="!strict"
            :disabled="configLocked"
            @click="emit('toggleStrict', false)"
          >经典通过</button>
          <button
            type="button"
            data-testid="strict-mode"
            :aria-pressed="strict"
            :disabled="configLocked"
            @click="emit('toggleStrict', true)"
          >严格赛制</button>
        </div>
      </div>
      <label class="angle-setting">
        <span>净绕角度</span>
        <select
          data-testid="required-angle"
          :value="requiredAngle"
          :disabled="configLocked || !strict"
          @change="emit('setRequiredAngle', Number(($event.target as HTMLSelectElement).value))"
        >
          <option :value="180">180°</option>
          <option :value="270">270°</option>
          <option :value="360">360°</option>
          <option :value="540">540°</option>
        </select>
      </label>
    </div>

    <ol>
      <li v-for="(gate, i) in gates" :key="gate.id" :data-state="i === nextGate ? 'next' : i < nextGate ? 'cleared' : 'later'">
        <span>{{ gate.id }}</span>{{ gate.name }}<Check v-if="i < nextGate" :size="16"/><MapPin v-else-if="i === nextGate" :size="15"/>
      </li>
    </ol>

    <div v-if="strict && attempt" class="rounding-panel" :data-status="attempt.status" data-testid="rounding-panel">
      <div class="rounding-head">
        <strong data-testid="rounding-status">
          <Check v-if="attempt.status === 'valid'" :size="15"/>
          <ShieldAlert v-else-if="attempt.status === 'invalid'" :size="15"/>
          <HelpCircle v-else-if="attempt.status === 'unconfirmed'" :size="15"/>
          <AlertTriangle v-else-if="attempt.status === 'abandoned'" :size="15"/>
          <MapPin v-else :size="15"/>
          {{ statusText[attempt.status] }}
        </strong>
        <span class="net-reading"><em>净绕行</em><output data-testid="rounding-net">{{ net }}° / {{ attempt.requiredAngle }}°</output></span>
      </div>
      <div class="progress-track" aria-hidden="true"><i :style="{ width: `${progress}%` }"></i></div>
      <svg v-if="sparkline" class="angle-sparkline" :viewBox="`0 0 ${sparkline.width} ${sparkline.height}`" role="img" aria-label="可回看的净绕行角度曲线" data-testid="net-angle-chart">
        <path :d="sparkline.area" fill="currentColor" opacity=".12"/>
        <line :x1="5" :x2="sparkline.width - 5" :y1="sparkline.zeroY" :y2="sparkline.zeroY" stroke="currentColor" stroke-opacity=".25"/>
        <line :x1="5" :x2="sparkline.width - 5" :y1="sparkline.targetY" :y2="sparkline.targetY" stroke="#4c7065" stroke-dasharray="4 3"/>
        <path :d="sparkline.line" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
      <div class="rounding-meta">
        <span>保护圈余量 <b data-testid="rounding-clearance" :data-danger="clearance !== null && clearance <= 1">{{ clearance === null ? '—' : `${clearance.toFixed(1)} px` }}</b></span>
        <span>标外侧 <b data-testid="rounding-outside" :data-ok="attempt.outside">{{ attempt.outside ? '通过' : '错误' }}</b></span>
        <span>旋向 <b>{{ attempt.direction === 1 ? '顺时针迹向' : '逆时针迹向' }}</b></span>
      </div>
      <p v-if="attempt.reason" class="rounding-reason" data-testid="rounding-reason">{{ attempt.reason }}</p>
      <p class="sweep-hint">图中青色叠层为按船首相位生成的船身扫过水域。</p>
    </div>
    <p v-else-if="strict" class="empty-note">穿过引导门和门线后建立绕标参考；沿旋向绕满并再次经过出口，才会确认换标。</p>

    <div class="penalty">累计罚时 <output data-testid="penalty">+{{ penalty }} s</output></div>
  </section>
</template>
