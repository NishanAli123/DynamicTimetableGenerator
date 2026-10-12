import React, { useState, useEffect } from 'react';
import { Calendar, Download, Loader2 } from 'lucide-react';
import './StudentTimetableViewer.css';
import { timetablesAPI, batchesAPI } from '../../services/api';
import { authAPI } from '../../services/api';

const StudentTimetableViewer = () => {
  const [selectedBatch, setSelectedBatch] = useState('');
  const [batches, setBatches] = useState([]);
  const [timetableData, setTimetableData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [timetableId, setTimetableId] = useState(null);

  useEffect(() => {
    // Get timetable info from user session
    const userStr = localStorage.getItem('user');
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        if (user.timetableId) {
          setTimetableId(user.timetableId);
        }
      } catch (err) {
        console.error('Error parsing user data:', err);
      }
    }
    fetchBatches();
  }, []);

  useEffect(() => {
    if (selectedBatch) {
      fetchTimetable(selectedBatch);
    } else {
      setTimetableData([]);
    }
  }, [selectedBatch, timetableId]);

  const fetchBatches = async () => {
    try {
      setLoading(true);
      const data = await batchesAPI.getAll();
      setBatches(data || []);
    } catch (err) {
      console.error('Error fetching batches:', err);
      setError(err.message || 'Failed to load batches');
    } finally {
      setLoading(false);
    }
  };

  const fetchTimetable = async (batchId) => {
    try {
      setLoading(true);
      const filters = { batchId };
      if (timetableId) {
        filters.timetableId = timetableId;
      }
      const entries = await timetablesAPI.getAll(filters);

      // Transform to display format
      const transformed = entries.map(entry => ({
        id: entry.id,
        day: entry.day_of_week.charAt(0).toUpperCase() + entry.day_of_week.slice(1),
        time: `${entry.start_time} - ${entry.end_time}`,
        subject: entry.subject?.name || 'TBA',
        teacher: entry.faculty?.name || 'TBA',
        room: entry.room?.name || 'TBA',
        type: entry.subject?.type || 'theory'
      }));

      setTimetableData(transformed);
    } catch (err) {
      console.error('Error fetching timetable:', err);
      setError(err.message || 'Failed to load timetable');
    } finally {
      setLoading(false);
    }
  };

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Get unique time slots from timetable data
  const timeSlots = Array.from(new Set(timetableData.map(item => item.time))).sort();

  const handleExport = () => {
    if (timetableData.length === 0) {
      alert('No timetable data to export');
      return;
    }

    // Create CSV content
    const csvContent = [
      ['Day', 'Time', 'Subject', 'Teacher', 'Room', 'Type'],
      ...timetableData.map(item => [
        item.day,
        item.time,
        item.subject,
        item.teacher,
        item.room,
        item.type
      ])
    ].map(row => row.join(',')).join('\n');

    // Create and download file
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    const batchName = batches.find(b => b.id === selectedBatch)?.name || 'timetable';
    a.href = url;
    a.download = `timetable_${batchName.replace(/\s+/g, '_')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  if (loading && !selectedBatch) {
    return (
      <div className="student-timetable-container">
        <div className="loading-container">
          <Loader2 className="spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="student-timetable-container">
      {selectedBatch && (
        <div className="student-timetable-header">
          <div className="student-timetable-title">
            <Calendar className="student-title-icon" />
            <h1>View Timetable</h1>
          </div>
          {timetableData.length > 0 && (
            <button className="student-export-button" onClick={handleExport}>
              <Download className="student-export-icon" />
              Export Timetable
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <button onClick={() => selectedBatch ? fetchTimetable(selectedBatch) : fetchBatches()}>Retry</button>
        </div>
      )}

      <div className="student-timetable-filters">
        <div className="student-filter-group">
          <label htmlFor="batch">Batch</label>
          <select
            id="batch"
            value={selectedBatch}
            onChange={(e) => setSelectedBatch(e.target.value)}
            className="student-filter-select"
          >
            <option value="">Select Batch</option>
            {batches.map(batch => (
              <option key={batch.id} value={batch.id}>
                {batch.name} ({batch.code})
              </option>
            ))}
          </select>
        </div>
      </div>

      {selectedBatch ? (
        loading ? (
          <div className="loading-container">
            <Loader2 className="spinner" />
            <p>Loading timetable...</p>
          </div>
        ) : timetableData.length > 0 ? (
          <div className="student-timetable-content">
            <div className="student-timetable-grid">
              <div className="student-timetable-header-row">
                <div className="student-time-header">Day</div>
                {timeSlots.map(slot => (
                  <div key={slot} className="student-day-header">{slot}</div>
                ))}
              </div>

              {timeSlots.length > 0 ? (
                days.map(day => (
                  <div key={day} className="student-timetable-row">
                    <div className="student-time-cell">{day}</div>
                    {timeSlots.map(timeSlot => {
                      const schedule = timetableData.find(item =>
                        item.day.toLowerCase() === day.toLowerCase() && item.time === timeSlot
                      );
                      return (
                        <div key={`${day}-${timeSlot}`} className="student-schedule-cell">
                          {schedule ? (
                            <div className="student-schedule-item">
                              <div className="student-subject">{schedule.subject}</div>
                              <div className="student-teacher">{schedule.teacher}</div>
                              <div className="student-room">{schedule.room}</div>
                              <div className={`student-type ${schedule.type.toLowerCase()}`}>
                                {schedule.type}
                              </div>
                            </div>
                          ) : (
                            <div className="student-empty-slot">-</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              ) : (
                <div className="empty-state" style={{ gridColumn: `span ${timeSlots.length + 1}` }}>
                  <p>No timetable entries found for this batch.</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="student-timetable-placeholder">
            <Calendar className="student-placeholder-icon" />
            <h3>No Timetable Found</h3>
            <p>No timetable has been generated for this batch yet.</p>
          </div>
        )
      ) : (
        <div className="student-timetable-placeholder">
          <Calendar className="student-placeholder-icon" />
          <h3>Select a Batch</h3>
          <p>Please select a batch to view its timetable</p>
        </div>
      )}
    </div>
  );
};

export default StudentTimetableViewer;
