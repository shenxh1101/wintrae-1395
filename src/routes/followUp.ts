import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import dayjs from 'dayjs'

const router = Router()

async function computeMemberRisks(members: any[], options: {
  storeId?: number
  periodStart: dayjs.Dayjs
  periodEnd: dayjs.Dayjs
  lowSlotThreshold?: number
  cancelThreshold?: number
  noShowThreshold?: number
  urgentHours?: number
}) {
  const { storeId, periodStart, periodEnd, lowSlotThreshold = 5, cancelThreshold = 2, noShowThreshold = 1, urgentHours = 24 } = options
  const now = new Date()
  const result: any[] = []

  for (const member of members) {
    const risks: string[] = []
    const riskDetails: Record<string, any> = {}

    const memberBookings = member.bookings.filter((b: any) => {
      const createdAt = dayjs(b.createdAt)
      if (createdAt.isBefore(periodStart) || createdAt.isAfter(periodEnd)) return false
      if (storeId && b.storeId !== storeId) return false
      return true
    })

    const memberStoreIds = [...new Set(memberBookings.map((b: any) => b.storeId))]

    const activePackages = member.packages.filter(
      (p: any) => p.remainSlots > 0 && (!p.expireAt || p.expireAt >= now)
    )
    const totalRemain = activePackages.reduce((s: number, p: any) => s + p.remainSlots, 0)
    const lowSlotPkg = activePackages.find((p: any) => p.remainSlots <= lowSlotThreshold && p.remainSlots > 0)
    if (lowSlotPkg) {
      risks.push('low_slot')
      riskDetails.lowSlot = {
        remainSlots: totalRemain,
        packageName: lowSlotPkg.package.name,
        packageRemain: lowSlotPkg.remainSlots,
        urgency: lowSlotPkg.remainSlots <= 1 ? 'critical' : lowSlotPkg.remainSlots <= 3 ? 'high' : 'medium',
      }
    }

    const expiringSoonPkg = activePackages.find(
      (p: any) => p.expireAt && dayjs(p.expireAt).diff(now, 'day') <= 14 && dayjs(p.expireAt).diff(now, 'day') >= 0
    )
    if (expiringSoonPkg) {
      risks.push('expiring_soon')
      riskDetails.expiringSoon = {
        packageName: expiringSoonPkg.package.name,
        expireAt: expiringSoonPkg.expireAt,
        daysLeft: expiringSoonPkg.expireAt ? dayjs(expiringSoonPkg.expireAt).diff(now, 'day') : null,
      }
    }

    const cancelledBookings = memberBookings.filter((b: any) => b.status === 'cancelled')
    if (cancelledBookings.length >= cancelThreshold) {
      risks.push('frequent_cancel')
      riskDetails.frequentCancel = {
        cancelCount: cancelledBookings.length,
        recentCancels: cancelledBookings.slice(0, 3).map((b: any) => ({
          bookingId: b.id,
          date: b.schedule.date,
          startAt: b.schedule.startAt,
          reason: b.cancelReason,
        })),
      }
    }

    const noShowList = memberBookings.filter((b: any) => b.status === 'no_show')
    if (noShowList.length >= noShowThreshold) {
      risks.push('frequent_noshow')
      riskDetails.frequentNoShow = {
        noShowCount: noShowList.length,
        recentNoShows: noShowList.slice(0, 3).map((b: any) => ({
          bookingId: b.id,
          date: b.schedule.date,
          startAt: b.schedule.startAt,
          reason: b.noShow?.reason,
        })),
      }
    }

    const pendingBookings = memberBookings
      .filter((b: any) => b.status === 'booked')
      .map((b: any) => {
        const startAt = dayjs(b.schedule.date).hour(Number(b.schedule.startAt.split(':')[0]))
        return { booking: b, hoursUntilStart: startAt.diff(now, 'minute') / 60 }
      })
      .filter((x: any) => x.hoursUntilStart <= urgentHours && x.hoursUntilStart >= -24)
      .sort((a: any, b: any) => a.hoursUntilStart - b.hoursUntilStart)

    if (pendingBookings.length > 0) {
      risks.push('pending_unconfirmed')
      riskDetails.pendingUnconfirmed = pendingBookings.map(({ booking, hoursUntilStart }: { booking: any; hoursUntilStart: number }) => ({
        bookingId: booking.id,
        date: booking.schedule.date,
        startAt: booking.schedule.startAt,
        storeId: booking.storeId,
        hoursUntilStart: Math.round(hoursUntilStart * 10) / 10,
        urgency: hoursUntilStart <= 1 ? 'critical' : hoursUntilStart <= 4 ? 'high' : 'medium',
      }))
    }

    if (risks.length > 0) {
      result.push({
        memberId: member.id,
        memberName: member.name,
        memberPhone: member.phone,
        storeIds: memberStoreIds,
        riskCount: risks.length,
        riskTypes: risks,
        riskDetails,
        latestFollowUp: member.followUps[0] || null,
      })
    }
  }

  result.sort((a, b) => {
    if (b.riskCount !== a.riskCount) return b.riskCount - a.riskCount
    const aCritical = a.riskTypes.some((r: string) => a.riskDetails[r.replace(/frequent_/, 'frequent').replace('_noshow', 'NoShow').replace(/_([a-z])/g, (_, c) => c.toUpperCase())]?.urgency === 'critical')
      || a.riskDetails.lowSlot?.urgency === 'critical'
    const bCritical = b.riskDetails.lowSlot?.urgency === 'critical'
    if (bCritical !== aCritical) return bCritical ? 1 : -1
    return 0
  })

  return result
}

router.get('/risk-overview', async (req: Request, res: Response) => {
  const { storeId, keyword, riskType, handler, status, startDate, endDate, lowSlotThreshold, cancelThreshold, noShowThreshold, urgentHours } = req.query as Record<string, string>
  const periodStart = startDate ? dayjs(startDate).startOf('day') : dayjs().subtract(30, 'day').startOf('day')
  const periodEnd = endDate ? dayjs(endDate).endOf('day') : dayjs().endOf('day')

  const whereMember: any = keyword
    ? { OR: [{ name: { contains: keyword } }, { phone: { contains: keyword } }] }
    : {}

  if (handler || status) {
    whereMember.followUps = {
      some: {
        ...(handler ? { handler: { contains: handler } } : {}),
        ...(status ? { status } : {}),
      },
    }
  }

  const members = await prisma.member.findMany({
    where: whereMember,
    include: {
      packages: { include: { package: true } },
      bookings: {
        include: { schedule: true, noShow: true },
      },
      followUps: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { id: 'asc' },
  })

  let memberRisks = await computeMemberRisks(members, {
    storeId: storeId ? Number(storeId) : undefined,
    periodStart,
    periodEnd,
    lowSlotThreshold: lowSlotThreshold ? Number(lowSlotThreshold) : undefined,
    cancelThreshold: cancelThreshold ? Number(cancelThreshold) : undefined,
    noShowThreshold: noShowThreshold ? Number(noShowThreshold) : undefined,
    urgentHours: urgentHours ? Number(urgentHours) : undefined,
  })

  if (riskType) {
    memberRisks = memberRisks.filter((r: any) => r.riskTypes.includes(riskType))
  }

  if (storeId) {
    memberRisks = memberRisks.filter((r: any) =>
      r.riskTypes.includes('low_slot') || r.riskTypes.includes('expiring_soon') || r.storeIds.includes(Number(storeId))
    )
  }

  res.json({
    data: memberRisks,
    filters: {
      storeId: storeId ? Number(storeId) : null,
      riskType: riskType || null,
      handler: handler || null,
      status: status || null,
      periodStart: periodStart.toDate(),
      periodEnd: periodEnd.toDate(),
    },
    summary: {
      totalAtRisk: memberRisks.length,
      lowSlotCount: memberRisks.filter((r: any) => r.riskTypes.includes('low_slot')).length,
      expiringSoonCount: memberRisks.filter((r: any) => r.riskTypes.includes('expiring_soon')).length,
      frequentCancelCount: memberRisks.filter((r: any) => r.riskTypes.includes('frequent_cancel')).length,
      frequentNoShowCount: memberRisks.filter((r: any) => r.riskTypes.includes('frequent_noshow')).length,
      pendingUnconfirmedCount: memberRisks.filter((r: any) => r.riskTypes.includes('pending_unconfirmed')).length,
      multiRiskCount: memberRisks.filter((r: any) => r.riskCount >= 2).length,
      byHandler: {} as Record<string, number>,
    },
  })
})

router.post('/', async (req: Request, res: Response) => {
  const { memberId, storeId, followType, coveredRisks, status, handler, remark } = req.body
  if (!memberId || !followType) return res.status(400).json({ error: 'memberId 和 followType 为必填' })

  const validTypes = ['low_slot', 'expiring_soon', 'frequent_cancel', 'frequent_noshow', 'pending_unconfirmed', 'other']
  if (!validTypes.includes(followType)) return res.status(400).json({ error: 'followType 不合法' })

  const validStatuses = ['pending', 'processing', 'resolved', 'ignored']
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'status 不合法' })

  const member = await prisma.member.findUnique({ where: { id: Number(memberId) } })
  if (!member) return res.status(404).json({ error: '会员不存在' })

  let coveredRiskArray: string[] = []
  if (coveredRisks) {
    if (!Array.isArray(coveredRisks)) return res.status(400).json({ error: 'coveredRisks 必须是数组' })
    const allRiskTypes = ['low_slot', 'expiring_soon', 'frequent_cancel', 'frequent_noshow', 'pending_unconfirmed']
    if (!coveredRisks.every((r: string) => allRiskTypes.includes(r))) {
      return res.status(400).json({ error: 'coveredRisks 包含非法风险类型' })
    }
    coveredRiskArray = coveredRisks
  }

  const followUp = await prisma.memberFollowUp.create({
    data: {
      memberId: Number(memberId),
      storeId: storeId ? Number(storeId) : null,
      followType,
      coveredRisks: coveredRiskArray.length > 0 ? JSON.stringify(coveredRiskArray) : null,
      status: status || 'pending',
      handler: handler || null,
      remark: remark || null,
    },
    include: { store: true },
  })

  res.status(201).json({
    data: {
      ...followUp,
      coveredRisks: followUp.coveredRisks ? JSON.parse(followUp.coveredRisks) : [],
    },
  })
})

router.get('/member/:memberId', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const { followType, status } = req.query as Record<string, string>

  const where: any = { memberId }
  if (followType) where.followType = followType
  if (status) where.status = status

  const followUps = await prisma.memberFollowUp.findMany({
    where,
    include: { store: true },
    orderBy: { createdAt: 'desc' },
  })

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, name: true, phone: true },
  })

  const parsed = followUps.map(f => ({
    ...f,
    coveredRisks: f.coveredRisks ? JSON.parse(f.coveredRisks) : [],
  }))

  res.json({ data: { member, history: parsed } })
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { status, handler, remark, coveredRisks } = req.body

  const validStatuses = ['pending', 'processing', 'resolved', 'ignored']
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'status 不合法' })

  let coveredRiskArray: string[] | undefined
  if (coveredRisks !== undefined) {
    if (!Array.isArray(coveredRisks)) return res.status(400).json({ error: 'coveredRisks 必须是数组' })
    const allRiskTypes = ['low_slot', 'expiring_soon', 'frequent_cancel', 'frequent_noshow', 'pending_unconfirmed']
    if (!coveredRisks.every((r: string) => allRiskTypes.includes(r))) {
      return res.status(400).json({ error: 'coveredRisks 包含非法风险类型' })
    }
    coveredRiskArray = coveredRisks
  }

  try {
    const followUp = await prisma.memberFollowUp.update({
      where: { id },
      data: {
        ...(status !== undefined ? { status } : {}),
        ...(handler !== undefined ? { handler } : {}),
        ...(remark !== undefined ? { remark } : {}),
        ...(coveredRiskArray !== undefined ? { coveredRisks: coveredRiskArray.length > 0 ? JSON.stringify(coveredRiskArray) : null } : {}),
      },
      include: { store: true },
    })
    res.json({
      data: {
        ...followUp,
        coveredRisks: followUp.coveredRisks ? JSON.parse(followUp.coveredRisks) : [],
      },
    })
  } catch {
    res.status(404).json({ error: '跟进记录不存在' })
  }
})

router.get('/summary', async (_req: Request, res: Response) => {
  const all = await prisma.memberFollowUp.findMany({
    select: { status: true, handler: true },
  })

  const summary: Record<string, number> = { pending: 0, processing: 0, resolved: 0, ignored: 0 }
  const byHandler: Record<string, { total: number; pending: number; processing: number; resolved: number; ignored: number }> = {}

  for (const f of all) {
    if (summary[f.status] !== undefined) summary[f.status]++
    if (f.handler) {
      if (!byHandler[f.handler]) byHandler[f.handler] = { total: 0, pending: 0, processing: 0, resolved: 0, ignored: 0 }
      byHandler[f.handler].total++
      if (byHandler[f.handler][f.status as keyof typeof byHandler[string]] !== undefined) {
        byHandler[f.handler][f.status as 'pending']++
      }
    }
  }

  res.json({
    data: {
      pendingCount: summary.pending,
      processingCount: summary.processing,
      resolvedCount: summary.resolved,
      ignoredCount: summary.ignored,
      total: all.length,
      byHandler,
    },
  })
})

router.post('/batch/assign', async (req: Request, res: Response) => {
  const { memberIds, handler, status } = req.body as { memberIds: number[]; handler?: string; status?: string }
  if (!Array.isArray(memberIds) || memberIds.length === 0)
    return res.status(400).json({ error: 'memberIds 为必填数组' })

  const validStatuses = ['pending', 'processing', 'resolved', 'ignored']
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'status 不合法' })

  let successCount = 0
  const failed: { memberId: number; error: string }[] = []

  for (const mid of memberIds) {
    try {
      await prisma.memberFollowUp.create({
        data: {
          memberId: mid,
          followType: 'other',
          handler: handler || null,
          status: status || 'pending',
          remark: handler ? `批量分派给 ${handler}` : null,
        },
      })
      successCount++
    } catch (e: any) {
      failed.push({ memberId: mid, error: e.message || '创建失败' })
    }
  }

  res.json({ data: { successCount, failed, total: memberIds.length } })
})

export default router
