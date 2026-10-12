/**
 * Timetable Generation Algorithm - TimetableMaster-style
 * 
 * Supports:
 * - Section model: Subject + Faculty + Class + Room as one unit
 * - Multiple faculty per subject (substitution/rotation)
 * - Randomized day/period selection for varied timetables
 * - Long sessions scheduled at the start or end of the day
 * - Room preferences per section
 */

import { solveCSP } from './cspSolver';
import { calculatePenalty } from './cspEngine';

// Fisher-Yates shuffle — produces a randomized copy of the array
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function generateTimetable(batches, subjects, schedule, faculties, rooms, options = {}) {
  const facultyPreferences = options.facultyPreferences || {};
  const allowFacultyPreferences = options.allowFacultyPreferences !== false;
  const scheduleList = options.scheduleList || null; // multi-schedule support
  const generatedTimetables = {};
  const facultySchedule = new Map(); // Track faculty availability: {facultyId: {day: [periods]}}
  const roomSchedule = new Map(); // Track room availability: {roomId: {day: [periods]}}
  const stats = {
    conflicts: 0,
    conflictDetails: [],   // Detailed info per unplaced session
    roomUtilization: 0,
    facultyLoad: {} // Track hours/periods per faculty
  };

  // Build a lookup: batchId → schedule (days map)
  // If scheduleList is provided, use per-batch mapping; otherwise fall back to the single `schedule`
  const batchScheduleMap = new Map();
  if (scheduleList && scheduleList.length > 0) {
    scheduleList.forEach(sch => {
      (sch.batchIds || []).forEach(bId => batchScheduleMap.set(bId, sch.days));
    });
    // Default schedule for batches not explicitly assigned
    const defaultSch = scheduleList[0].days;
    batches.forEach(b => { if (!batchScheduleMap.has(b.id)) batchScheduleMap.set(b.id, defaultSch); });
  } else {
    // Legacy: every batch uses the same schedule
    batches.forEach(b => batchScheduleMap.set(b.id, schedule));
  }

  // Initialize tracking maps
  faculties.forEach(faculty => {
    facultySchedule.set(faculty.id, {
      monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: []
    });
  });

  rooms.forEach(room => {
    roomSchedule.set(room.id, {
      monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: []
    });
  });

  // ── PRE-LOOP: Schedule combined (cross-batch) sessions first ──────────────
  // Combined sessions share the same slot across multiple batches.
  // We schedule them before per-batch processing so they don't conflict.
  const combinedSessionsMap = new Map(); // combinedGroupId -> { subject, batchIds, ... }
  const batchUsedPeriodsMap = new Map(); // batchId -> { day: Set<startTime> }

  // Initialize batchUsedPeriodsMap for all batches
  batches.forEach(b => {
    batchUsedPeriodsMap.set(b.id, {
      monday: new Set(), tuesday: new Set(), wednesday: new Set(),
      thursday: new Set(), friday: new Set(), saturday: new Set()
    });
  });

  // Initialize generatedTimetables for all batches
  batches.forEach(b => {
    generatedTimetables[b.id] = {
      monday: [], tuesday: [], wednesday: [],
      thursday: [], friday: [], saturday: []
    };
  });

  // Scan all batches for combined sessions
  for (const batch of batches) {
    const batchSubjects = subjects[batch.id] || [];
    batchSubjects.forEach(subject => {
      if (subject.linkedBatchIds && subject.linkedBatchIds.length > 0 && subject.combinedGroupId) {
        if (!combinedSessionsMap.has(subject.combinedGroupId)) {
          combinedSessionsMap.set(subject.combinedGroupId, {
            subject: { ...subject },
            batchIds: [...new Set([batch.id, ...subject.linkedBatchIds])],
            combinedGroupId: subject.combinedGroupId,
          });
        }
      }
    });
  }

  // Schedule each combined session
  const daysForCombined = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  for (const [groupId, combined] of combinedSessionsMap) {
    const { subject, batchIds } = combined;
    const freqCfg = subject.frequencyConfig || [{ count: 1, length: subject.consecutivePeriods || 1 }];

    freqCfg.forEach(cfg => {
      for (let sessIdx = 0; sessIdx < (cfg.count || 1); sessIdx++) {
        const consecutive = cfg.length || 1;
        let placed = false;

        // Find a day+time where ALL linked batches are free
        const shuffledDays = shuffle([...daysForCombined]);

        for (const day of shuffledDays) {
          if (placed) break;

          // Get class periods common to all linked batches
          const allBatchPeriods = batchIds.map(bId => {
            const batchSch = batchScheduleMap.get(bId) || schedule;
            return (batchSch[day] || []).filter(p => p.type === 'class');
          });

          // Find time slots available in ALL batches
          const commonTimes = allBatchPeriods[0]?.filter(p =>
            allBatchPeriods.every(bPeriods =>
              bPeriods.some(bp => bp.startTime === p.startTime)
            )
          ) || [];

          const availPeriods = shuffle(commonTimes);

          if (consecutive > 1) {
            // Multi-period combined session
            for (let i = 0; i <= availPeriods.length - consecutive; i++) {
              const periodGroup = availPeriods.slice(i, i + consecutive);
              // Check all batches have these slots free
              const allFree = batchIds.every(bId =>
                periodGroup.every(p => !batchUsedPeriodsMap.get(bId)?.[day]?.has(p.startTime))
              );
              if (!allFree) continue;

              // Check faculty is available
              const result = canAssignPeriods(periodGroup, subject, day, facultySchedule, roomSchedule, batches[0], rooms, faculties, {}, false);
              if (!result) continue;

              // Assign to all linked batches
              const assignedSubject = { ...subject, facultyId: result.facultyId };
              const room = findAvailableRoom(subject, rooms, roomSchedule, day, periodGroup[0]);

              for (const bId of batchIds) {
                const batchObj = batches.find(b => b.id === bId);
                periodGroup.forEach((period, idx) => {
                  const entry = createTimetableEntry(period, assignedSubject, day, room, idx, faculties, batchObj);
                  entry._isCombined = true;
                  entry._combinedGroupId = groupId;
                  entry._combinedBatchIds = batchIds;
                  entry.subject = `${entry.subject} [Combined]`;
                  generatedTimetables[bId][day].push(entry);
                  batchUsedPeriodsMap.get(bId)[day].add(period.startTime);
                });
              }

              // Mark faculty/room used (once — shared)
              periodGroup.forEach(period => {
                markPeriodUsed(period, assignedSubject, room, day, facultySchedule, roomSchedule, faculties, stats);
              });

              placed = true;
              break;
            }
          } else {
            // Single-period combined session
            for (const period of availPeriods) {
              const allFree = batchIds.every(bId =>
                !batchUsedPeriodsMap.get(bId)?.[day]?.has(period.startTime)
              );
              if (!allFree) continue;

              const result = canAssignPeriod(period, subject, day, facultySchedule, roomSchedule, batches[0], rooms, faculties, {}, false);
              if (!result) continue;

              const assignedSubject = { ...subject, facultyId: result.facultyId };
              const room = findAvailableRoom(subject, rooms, roomSchedule, day, period);

              for (const bId of batchIds) {
                const batchObj = batches.find(b => b.id === bId);
                const entry = createTimetableEntry(period, assignedSubject, day, room, 0, faculties, batchObj);
                entry._isCombined = true;
                entry._combinedGroupId = groupId;
                entry._combinedBatchIds = batchIds;
                entry.subject = `${entry.subject} [Combined]`;
                generatedTimetables[bId][day].push(entry);
                batchUsedPeriodsMap.get(bId)[day].add(period.startTime);
              }

              markPeriodUsed(period, assignedSubject, room, day, facultySchedule, roomSchedule, faculties, stats);
              placed = true;
              break;
            }
          }
        }

        if (!placed) {
          stats.conflicts++;
          stats.conflictDetails.push({
            batchId: batchIds[0],
            batchName: batches.find(b => b.id === batchIds[0])?.name || batchIds[0],
            subjectName: `${subject.name} [Combined: ${batchIds.join(', ')}]`,
            subjectKey: groupId,
            consecutivePeriods: consecutive,
            reason: 'No common free slot across all linked batches.'
          });
        }
      }
    });
  }

  // Build set of combinedGroupIds to skip in per-batch processing
  const combinedGroupIds = new Set(combinedSessionsMap.keys());

  // Process each batch
  batches.forEach(batch => {
    // Use pre-initialized timetable (may already have combined sessions)
    const batchTimetable = generatedTimetables[batch.id] || {
      monday: [], tuesday: [], wednesday: [],
      thursday: [], friday: [], saturday: []
    };

    // Use pre-initialized used periods (may already have combined sessions marked)
    const batchUsedPeriods = batchUsedPeriodsMap.get(batch.id) || {
      monday: new Set(), tuesday: new Set(), wednesday: new Set(),
      thursday: new Set(), friday: new Set(), saturday: new Set()
    };

    // Filter out combined sessions — they've already been scheduled in the pre-loop
    const batchSubjects = (subjects[batch.id] || []).filter(s => !s.combinedGroupId || !combinedGroupIds.has(s.combinedGroupId));

    // Get class periods from THIS BATCH's schedule (exclude breaks/lunch)
    const batchSch = batchScheduleMap.get(batch.id) || schedule;
    const classPeriods = {};
    Object.entries(batchSch).forEach(([day, periods]) => {
      classPeriods[day] = periods.filter(p => p.type === 'class');
    });

    // ── Build a flat list of "sessions" to schedule ──────────────────────────
    // Each session is one block of consecutive periods to place on one day.
    // e.g. frequencyConfig [{count:3, length:1}] → 3 sessions of 1 period each
    //      frequencyConfig [{count:2, length:2}] → 2 sessions of 2 consecutive periods

    const groupSets = new Map();   // groupSetId -> [subject, ...]
    const standaloneSubjects = [];

    batchSubjects.forEach(subject => {
      let setId = subject.groupSetId;
      if (!setId && subject.groupName && subject.id) {
        const parts = subject.id.split('-');
        if (parts.length >= 2) setId = `inferred-${parts[1]}`;
      }
      if (setId) {
        if (!groupSets.has(setId)) groupSets.set(setId, []);
        groupSets.get(setId).push(subject);
      } else {
        standaloneSubjects.push(subject);
      }
    });

    // Explode frequency configs into individual sessions
    const standaloneSessions = [];
    standaloneSubjects.forEach(subject => {
      const freqCfg = subject.frequencyConfig || [{ count: Math.ceil((subject.periodsPerWeek || 3) / (subject.consecutivePeriods || 1)), length: subject.consecutivePeriods || 1 }];
      freqCfg.forEach(cfg => {
        for (let i = 0; i < (cfg.count || 1); i++) {
          standaloneSessions.push({
            type: 'standalone',
            subject,
            consecutivePeriods: cfg.length || 1,
            subjectKey: subject.id || subject.name,
          });
        }
      });
    });

    const groupSessions = [];
    for (const [groupSetId, groupMembers] of groupSets) {
      const ref = groupMembers[0];
      const freqCfg = ref.frequencyConfig || [{ count: Math.ceil((ref.periodsPerWeek || 3) / (ref.consecutivePeriods || 1)), length: ref.consecutivePeriods || 1 }];
      freqCfg.forEach(cfg => {
        for (let i = 0; i < (cfg.count || 1); i++) {
          groupSessions.push({
            type: 'group',
            groupSetId,
            groupMembers,
            consecutivePeriods: cfg.length || 1,
            subjectKey: groupSetId,
          });
        }
      });
    }

    // Shuffle first for randomness, then stable-sort: labs first, longest sessions first
    const allSessions = shuffle([...groupSessions, ...standaloneSessions]);
    allSessions.sort((a, b) => {
      const aLab = (a.subject?.type === 'lab' || a.groupMembers?.[0]?.type === 'lab') ? 1 : 0;
      const bLab = (b.subject?.type === 'lab' || b.groupMembers?.[0]?.type === 'lab') ? 1 : 0;
      if (bLab !== aLab) return bLab - aLab;
      return b.consecutivePeriods - a.consecutivePeriods;
    });

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    // Track how many class slots are used per day (for load-balancing)
    const dayLoad = {};
    days.forEach(d => dayLoad[d] = 0);



    // ── CSP Variable Setup ──
    const unassignedVars = allSessions.map((session, index) => {
      let domain = [];
      const { consecutivePeriods } = session;

      // randomize domain to maintain varied timetables
      for (const day of shuffle([...days])) {
        const rawPeriods = classPeriods[day] || [];
        if (rawPeriods.length < consecutivePeriods) continue;

        for (let i = 0; i <= rawPeriods.length - consecutivePeriods; i++) {
          const periodGroup = rawPeriods.slice(i, i + consecutivePeriods);
          
          if (!periodGroup.every(p => !batchUsedPeriods[day].has(p.startTime))) continue;

          let blockAssignments = [];
          let allCanAssign = true;

          const members = session.type === 'group' ? session.groupMembers : [session.subject];
          
          for (const member of members) {
            const result = consecutivePeriods > 1 ? 
              canAssignPeriods(periodGroup, member, day, facultySchedule, roomSchedule, batch, rooms, faculties, facultyPreferences, allowFacultyPreferences) :
              canAssignPeriod(periodGroup[0], member, day, facultySchedule, roomSchedule, batch, rooms, faculties, facultyPreferences, allowFacultyPreferences);
            
            if (result) blockAssignments.push({ member, facultyId: result.facultyId });
            else { allCanAssign = false; break; }
          }

          if (allCanAssign) {
            domain.push({ day, periodGroup, blockAssignments });
          }
        }
      }
      return { ...session, id: index, domain };
    });

    const stateFunctions = {
      canAssign: (v, val) => {
        if (!val.periodGroup.every(p => !batchUsedPeriods[val.day].has(p.startTime))) return false;
        
        for (const asm of val.blockAssignments) {
          const result = v.consecutivePeriods > 1 ? 
            canAssignPeriods(val.periodGroup, asm.member, val.day, facultySchedule, roomSchedule, batch, rooms, faculties, facultyPreferences, allowFacultyPreferences) :
            canAssignPeriod(val.periodGroup[0], asm.member, val.day, facultySchedule, roomSchedule, batch, rooms, faculties, facultyPreferences, allowFacultyPreferences);
          
          if (!result || result.facultyId !== asm.facultyId) return false;
        }
        return true;
      },
      assign: (v, val) => {
        val.periodGroup.forEach(p => batchUsedPeriods[val.day].add(p.startTime));
        val.blockAssignments.forEach(asm => {
          const room = findAvailableRoom(asm.member, rooms, roomSchedule, val.day, val.periodGroup[0]);
          val.periodGroup.forEach((p, idx) => {
            const assignedSubject = { ...asm.member, facultyId: asm.facultyId };
            const entry = createTimetableEntry(p, assignedSubject, val.day, room, idx, faculties, batch);
            
            if (v.type === 'group') {
               entry.subject += asm.member.groupName ? ` [${asm.member.groupName}]` : '';
               entry.isGroupSession = true;
               entry.groupSetId = v.groupSetId;
            }
            
            entry._asmId = asm.member.id; // helps identifying for unassign
            batchTimetable[val.day].push(entry);
            markPeriodUsed(p, assignedSubject, room, val.day, facultySchedule, roomSchedule, faculties, stats);
          });
        });
      },
      unassign: (v, val) => {
        val.periodGroup.forEach(p => batchUsedPeriods[val.day].delete(p.startTime));
        val.blockAssignments.forEach(asm => {
          const assignedSubject = { ...asm.member, facultyId: asm.facultyId };
          const room = findAvailableRoom(asm.member, rooms, roomSchedule, val.day, val.periodGroup[0]); 
          
          val.periodGroup.forEach(p => {
             unmarkPeriodUsed(p, assignedSubject, room, val.day, facultySchedule, roomSchedule, faculties, stats);
             // Remove from batchTimetable
             const dayArr = batchTimetable[val.day];
             for (let i = dayArr.length - 1; i >= 0; i--) {
                const entry = dayArr[i];
                if (entry.time.startsWith(p.startTime) && entry._asmId === asm.member.id) {
                    dayArr.splice(i, 1);
                    break;
                }
             }
          });
        });
      }
    };

    // Run CSP
    const cspResult = solveCSP(unassignedVars, stateFunctions, 10000);
    const assignments = cspResult.assignments;

    // Filter unassigned
    const assignedIds = new Set(assignments.map(a => a.variable.id));
    for (const v of unassignedVars) {
      if (!assignedIds.has(v.id)) {
         stats.conflicts = (stats.conflicts || 0) + 1;
         const subName = v.subject?.name || v.groupMembers?.map(m => m.name).join(', ') || v.subjectKey;
         stats.conflictDetails.push({
           batchId: batch.id,
           batchName: batch.name || batch.code || batch.id,
           subjectName: subName,
           subjectKey: v.subjectKey,
           consecutivePeriods: v.consecutivePeriods,
           reason: `CSP Solver failed to place this session without causing conflicts.`
         });
      }
    }

    // ── Add breaks and lunch from the batch's schedule ───────────────────────
    const batchSchForBreaks = batchScheduleMap.get(batch.id) || schedule;
    Object.entries(batchSchForBreaks).forEach(([day, periods]) => {
      periods.forEach(period => {
        if (period.type === 'break' || period.type === 'lunch') {
          batchTimetable[day].push({
            time: `${period.startTime}-${period.endTime}`,
            subject: period.name,
            faculty: '',
            room: '',
            type: period.type
          });
        }
      });
    });

    // Sort periods by time for each day
    Object.keys(batchTimetable).forEach(day => {
      batchTimetable[day].sort((a, b) => {
        const aTime = a.time.split('-')[0];
        const bTime = b.time.split('-')[0];
        return aTime.localeCompare(bTime);
      });
    });

    generatedTimetables[batch.id] = batchTimetable;
  });

  // Calculate statistics
  const totalRoomSlots = rooms.length * 6 * 8; // rooms * days * periods
  if (totalRoomSlots > 0) {
    const usedRoomSlots = Array.from(roomSchedule.values()).reduce((total, daySchedule) => {
      return total + Object.values(daySchedule).reduce((sum, periods) => sum + periods.length, 0);
    }, 0);
    stats.roomUtilization = Math.round((usedRoomSlots / totalRoomSlots) * 100);
  } else {
    stats.roomUtilization = 'N/A';
  }

  return { generatedTimetables, stats };
}

function getSubjectFacultyIds(subject, faculties) {
  if (subject.facultyIds && subject.facultyIds.length > 0) {
    return subject.facultyIds;
  }
  const id = subject.facultyId || (subject.faculty ? faculties.find(f => f.name === subject.faculty)?.id : null);
  return id ? [id] : [];
}

// Faculty preference avoidance is currently disabled — always returns false.
// The original logic checked a time_matrix for 'avoid' slots.
function isSlotAvoidedByFaculty(/* facultyId, day, period, facultyPreferences, allowPrefs */) {
  return false;
}

function canAssignPeriods(periodGroup, subject, day, facultySchedule, roomSchedule, batch, rooms, faculties, facultyPreferences, allowFacultyPreferences) {
  const facultyIds = getSubjectFacultyIds(subject, faculties);
  if (facultyIds.length === 0) return false;

  let assignedFacultyId = null;
  for (const facultyId of facultyIds) {
    const facultyDaySchedule = facultySchedule.get(facultyId)?.[day] || [];
    let canUse = true;
    for (const period of periodGroup) {
      if (facultyDaySchedule.some(p => p.startTime === period.startTime)) {
        canUse = false;
        break;
      }
      if (isSlotAvoidedByFaculty(facultyId, day, period, facultyPreferences, allowFacultyPreferences)) {
        canUse = false;
        break;
      }
    }
    if (canUse) {
      assignedFacultyId = facultyId;
      break;
    }
  }
  if (!assignedFacultyId) return false;

  // Room is optional — only check if rooms exist and a room is explicitly requested
  if (rooms && rooms.length > 0 && ((subject.roomIds && subject.roomIds.length > 0) || subject.roomId)) {
    // Check if the explicitly requested room is available for ALL periods in the group
    let hasRoomForAll = false;
    
    // Test if there's at least one requested room available for all periods
    const explicitRoomIds = subject.roomIds?.length > 0 ? subject.roomIds : [subject.roomId];
    
    for (const rid of explicitRoomIds) {
      const preferredRoom = rooms.find(r => r.id === rid);
      if (preferredRoom) {
        const roomDaySchedule = roomSchedule.get(preferredRoom.id)?.[day] || [];
        const isFreeForAll = periodGroup.every(p => !roomDaySchedule.some(rds => rds.startTime === p.startTime));
        if (isFreeForAll) {
          hasRoomForAll = true;
          break;
        }
      }
    }
    
    if (!hasRoomForAll) return false;
  }

  return { facultyId: assignedFacultyId };
}

function canAssignPeriod(period, subject, day, facultySchedule, roomSchedule, batch, rooms, faculties, facultyPreferences, allowFacultyPreferences) {
  const facultyIds = getSubjectFacultyIds(subject, faculties);
  if (facultyIds.length === 0) return false;

  let assignedFacultyId = null;
  for (const facultyId of facultyIds) {
    const facultyDaySchedule = facultySchedule.get(facultyId)?.[day] || [];
    if (facultyDaySchedule.some(p => p.startTime === period.startTime)) continue;
    if (isSlotAvoidedByFaculty(facultyId, day, period, facultyPreferences, allowFacultyPreferences)) continue;
    assignedFacultyId = facultyId;
    break;
  }
  if (!assignedFacultyId) return false;

  // Room is optional — only check if rooms exist and a room is explicitly requested
  if (rooms && rooms.length > 0 && ((subject.roomIds && subject.roomIds.length > 0) || subject.roomId)) {
    const explicitRoomIds = subject.roomIds?.length > 0 ? subject.roomIds : [subject.roomId];
    let hasRoom = false;
    for (const rid of explicitRoomIds) {
      const preferredRoom = rooms.find(r => r.id === rid);
      if (preferredRoom) {
        const roomDaySchedule = roomSchedule.get(preferredRoom.id)?.[day] || [];
        if (!roomDaySchedule.some(p => p.startTime === period.startTime)) {
          hasRoom = true;
          break;
        }
      }
    }
    if (!hasRoom) return false;
  }

  return { facultyId: assignedFacultyId };
}

function findAvailableRoom(subject, rooms, roomSchedule, day, period) {
  // No rooms defined — return null gracefully
  if (!rooms || rooms.length === 0) return null;

  // Prefer section's assigned room if explicitly available
  const explicitRoomIds = subject.roomIds?.length > 0 ? subject.roomIds : (subject.roomId ? [subject.roomId] : []);
  
  for (const rid of explicitRoomIds) {
    const preferredRoom = rooms.find(r => r.id === rid);
    if (preferredRoom) {
      const roomDaySchedule = roomSchedule.get(preferredRoom.id)?.[day] || [];
      if (!roomDaySchedule.some(p => p.startTime === period.startTime)) {
        return preferredRoom;
      }
    }
  }

  // Only allocate a room to a session if it is explicitly set
  // (We removed the fallback logic that assigned arbitrary rooms)
  return null;
}

function createTimetableEntry(period, subject, day, room, index, faculties, batch) {
  // Get faculty name and ID from faculties array
  let facultyName = 'TBA';
  let facultyId = null;
  if (subject.facultyId) {
    const faculty = faculties.find(f => f.id === subject.facultyId);
    facultyName = faculty ? faculty.name : (subject.faculty || 'TBA');
    facultyId = subject.facultyId;
  } else if (subject.faculty) {
    facultyName = subject.faculty;
  }

  // No fallback to batch name — if no room, show 'TBA' or empty
  const roomName = room ? room.name : 'TBA';
  const roomId = room ? room.id : null;

  return {
    time: `${period.startTime}-${period.endTime}`,
    subject: subject.name,
    faculty: facultyName,
    room: roomName,
    type: subject.type || 'theory',
    // Embed database IDs for direct saving
    _subjectId: subject.subjectId || subject.id || null,
    _facultyId: facultyId,
    _roomId: roomId,
    _batchId: batch?.id || null,
    consecutivePeriods: subject.consecutivePeriods || 1,
  };
}

function markPeriodUsed(period, subject, room, day, facultySchedule, roomSchedule, faculties, stats) {
  const facultyId = subject.facultyId || (subject.faculty ? faculties.find(f => f.name === subject.faculty)?.id : null);

  if (facultyId && facultySchedule.has(facultyId)) {
    if (!facultySchedule.get(facultyId)[day]) {
      facultySchedule.get(facultyId)[day] = [];
    }
    facultySchedule.get(facultyId)[day].push({
      startTime: period.startTime,
      endTime: period.endTime
    });

    // Update Load Stats
    stats.facultyLoad[facultyId] = (stats.facultyLoad[facultyId] || 0) + 1;
  }

  if (room && roomSchedule.has(room.id)) {
    if (!roomSchedule.get(room.id)[day]) {
      roomSchedule.get(room.id)[day] = [];
    }
    roomSchedule.get(room.id)[day].push({
      startTime: period.startTime,
      endTime: period.endTime
    });
  }
}

function unmarkPeriodUsed(period, subject, room, day, facultySchedule, roomSchedule, faculties, stats) {
  const facultyId = subject.facultyId || (subject.faculty ? faculties.find(f => f.name === subject.faculty)?.id : null);

  if (facultyId && facultySchedule.has(facultyId)) {
    const arr = facultySchedule.get(facultyId)[day];
    if (arr) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].startTime === period.startTime) {
          arr.splice(i, 1);
          break;
        }
      }
    }
    if (stats.facultyLoad[facultyId]) stats.facultyLoad[facultyId]--;
  }

  if (room && roomSchedule.has(room.id)) {
    const arr = roomSchedule.get(room.id)[day];
    if (arr) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].startTime === period.startTime) {
          arr.splice(i, 1);
          break;
        }
      }
    }
  }
}
