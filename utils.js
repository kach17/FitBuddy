import * as chrono from 'chrono-node';

// Activity type mapping for role mentions
export const ACTIVITY_ROLES = {
  run: 'Runner',
  hike: 'Hiker',
  cycle: 'Cyclist',
  bike: 'Cyclist'
};

export const ACTIVITY_EMOJIS = {
  run: '🏃',
  hike: '🥾',
  cycle: '🚴',
  bike: '🚴'
};

// Parse natural language into structured event data
export function parseBeaconInput(sentence, userDefaults) {
  const parsed = chrono.parse(sentence, new Date(), { forwardDate: true });
  const timeData = parsed[0];
  
  // Extract activity type from sentence
  let activityType = null;
  for (const [key, _] of Object.entries(ACTIVITY_ROLES)) {
    if (sentence.toLowerCase().includes(key)) {
      activityType = key;
      break;
    }
  }
  
  // Extract location (anything after "at" or "in")
  const locationMatch = sentence.match(/(?:at|in)\s+([^,]+)/i);
  const location = locationMatch ? locationMatch[1].trim() : null;
  
  // Extract city (anything after location with comma or standalone)
  const cityMatch = sentence.match(/,\s*([A-Za-z\s]+)$/);
  const city = cityMatch ? cityMatch[1].trim() : null;
  
  return {
    timestamp: timeData?.start?.date() || null,
    activity: activityType || userDefaults?.last_activity_type || 'run',
    location: location || 'TBD',
    city: city || userDefaults?.default_city || 'Duisburg'
  };
}

// Format date for Discord embed
export function formatEventTime(date) {
  const now = new Date();
  const isCurrentYear = date.getFullYear() === now.getFullYear();
  
  const dateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(isCurrentYear ? {} : { year: 'numeric' })
  }).format(date);
  
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, '0');
  
  return `${dateStr} • ${displayHours}:${displayMinutes} ${ampm}`;
}

// Mock weather API response
export function getMockWeather(city) {
  const conditions = ['Sunny', 'Partly Cloudy', 'Light Rain', 'Clear'];
  const temp = Math.floor(Math.random() * 15) + 10;
  return `${temp}°C, ${conditions[Math.floor(Math.random() * conditions.length)]}`;
}

// Check if event time has passed
export function hasEventPassed(eventTimestamp) {
  return new Date(eventTimestamp) <= new Date();
}
