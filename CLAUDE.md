# CLAUDE.md

## Project Name

Fleet Board Pro

## Project Overview

Fleet Board Pro is a vehicle location, delivery request, and fleet status management web app for shop/company operations.

The app helps outlets, managers, admins, and drivers coordinate vehicle requests, track vehicle availability, and view driver/vehicle location updates.

The main purpose is to make vehicle movement clear, fast, and easy to manage.

## Core Goal

Build a simple, reliable system where:

1. Outlet/shop staff can request a vehicle.
2. Manager/admin can view and manage requests.
3. Driver can accept, start, update, and complete jobs.
4. Vehicle status updates automatically.
5. Manager/admin can see which vehicles are available, busy, or offline.
6. Driver location can be shown on the map when available.

## Tech Stack

Use the existing project stack unless the user clearly asks to change it.

Expected stack:

* Frontend: HTML, CSS, JavaScript
* Backend: Supabase
* Database: Supabase PostgreSQL
* Auth: Supabase Auth
* Realtime: Supabase Realtime where useful
* Map: Leaflet.js or similar map library
* App type: Web app / PWA style

## Important Project Rule

Do not rewrite the whole project unless the user clearly asks for a full rebuild.

Prefer small, safe, focused changes.

Before changing important logic, first understand the current structure and explain what will be changed.

## Main User Roles

### Admin

Admin has full control.

Admin can:

* Manage companies
* Manage outlets
* Manage vehicles
* Manage drivers
* Manage users
* View all requests
* View all vehicle statuses
* View location updates
* View reports/history

### Manager

Manager controls daily operations.

Manager can:

* View outlet requests
* Assign or approve jobs
* See available and busy vehicles
* See drivers
* See job history
* Monitor location updates
* Cancel or close requests when needed

### Outlet / Shop Staff

Outlet staff can request vehicles.

Outlet staff can:

* Create vehicle request
* Add customer/delivery details
* Add pickup/drop-off information
* View request status
* See whether request is pending, accepted, in progress, completed, or cancelled

Outlet staff should not see admin-only or manager-only data.

### Driver

Driver handles assigned jobs.

Driver can:

* View jobs assigned to them
* Accept a request
* Start a trip
* Update status
* Complete the job
* Share/update location if enabled
* Add notes or delivery proof if the feature exists

Driver should only see their own assigned jobs and relevant vehicle details.

## Company System

The app should support a multi-company setup.

Each company can have its own:

* Company code
* Users
* Drivers
* Vehicles
* Outlets
* Requests
* Job history

Example company code:

```
GLOW2026
```

Never mix data between companies.

All important tables should be linked to company_id or company code.

## Vehicle Status Logic

Vehicle status is very important.

Expected vehicle statuses:

```
available
busy
offline
maintenance
```

Basic rules:

* When no active job exists, vehicle should be available.
* When a driver accepts or starts a job, vehicle should become busy.
* When job is completed, vehicle should return to available.
* When job is cancelled before starting, vehicle should return to available.
* When a vehicle is unavailable due to repair/service, use maintenance.
* When location has not updated for a long time, the app may show vehicle as offline.

Do not leave a vehicle stuck as busy after job completion or cancellation.

## Request / Job Status Logic

Expected request/job statuses:

```
pending
accepted
in_progress
completed
cancelled
```

Recommended flow:

```
pending → accepted → in_progress → completed
```

Cancellation can happen before completion:

```
pending → cancelled
accepted → cancelled
in_progress → cancelled
```

When a job is completed:

* Mark job as completed
* Save completed time
* Return vehicle to available
* Save driver notes/proof if available

When a job is cancelled:

* Mark job as cancelled
* Save cancellation reason if available
* Return vehicle to available if it was assigned

## Location Tracking

Vehicle/driver location may use:

```
last_lat
last_lng
last_updated
```

Important rules:

* Store location only for the correct driver/vehicle/company.
* Do not expose all drivers' locations to outlet users unless allowed.
* Manager/admin can view location.
* Driver should only update their own location.
* Use timestamps to check if location is fresh or old.
* If location is old, show it clearly as outdated/offline.

Location display should be clear and simple.

Do not fake location data.

## Supabase Security Rules

Security is critical.

### Frontend Key Rule

Only use Supabase anon key in frontend files.

Never put Supabase service_role key in frontend code.

Never expose private keys in:

* HTML
* JavaScript
* CSS
* Public GitHub repo
* Browser console
* Client-side config

### Row Level Security

Use Supabase Row Level Security where possible.

Rules should protect:

* Company data separation
* Role-based access
* Driver-only job access
* Outlet-only request access
* Manager/admin operational access

### Auth Rules

Users should be connected to their role and company.

A user profile should include:

```
user_id
company_id
role
name
email
phone
outlet_id
driver_id
vehicle_id
active
```

Do not rely only on frontend hiding. Sensitive data must also be protected in the database.

## Database Guidelines

Keep database structure clean and understandable.

Expected main tables may include:

```
companies
users / profiles
outlets
vehicles
drivers
vehicle_requests
jobs
location_updates
job_notes
delivery_proofs
```

Use clear names.

Avoid unclear short names unless already used in the project.

Important fields for vehicles:

```
id
company_id
vehicle_name
plate_number
driver_id
status
last_lat
last_lng
last_updated
active
created_at
updated_at
```

Important fields for requests/jobs:

```
id
company_id
outlet_id
driver_id
vehicle_id
status
pickup_location
dropoff_location
customer_name
customer_contact
notes
requested_by
accepted_at
started_at
completed_at
cancelled_at
created_at
updated_at
```

Do not rename existing columns unless necessary.

If renaming is required, explain the migration clearly.

## Frontend Guidelines

Keep the frontend easy for non-technical shop staff.

Use simple words and clear buttons.

Good button labels:

```
Request Vehicle
Accept Job
Start Trip
Complete Job
Cancel Request
View Location
Back
Save
```

Avoid complicated wording.

Manager dashboard should show:

* Pending requests
* Active jobs
* Available vehicles
* Busy vehicles
* Offline vehicles
* Recent completed jobs

Driver dashboard should show:

* Current assigned job
* Pickup details
* Drop-off details
* Customer/contact details
* Start and complete buttons
* Location update status

Outlet dashboard should show:

* Create new request
* My active requests
* Request status
* Completed/cancelled history if needed

## UI Design Style

Use a clean, professional dashboard style.

Preferred style:

* Dark premium dashboard look is acceptable
* Clear cards
* Big readable text
* Simple icons if available
* Status badges
* Mobile-friendly layout
* Driver screen should be very simple
* Avoid too many controls on one screen

Status badge examples:

```
Available
Busy
Pending
Accepted
In Progress
Completed
Cancelled
Offline
Maintenance
```

Use consistent colors for status badges.

## Mobile First

This app will likely be used from phones.

Always check:

* Buttons are large enough
* Text is readable
* Forms are not too long
* Driver can use it quickly
* Outlet staff can request vehicle easily
* Manager can see important information without zooming

## Realtime Behavior

Use realtime updates where useful, especially for:

* New vehicle requests
* Job status changes
* Vehicle status changes
* Location updates

Do not overcomplicate realtime logic.

If realtime causes issues, use simple refresh or polling as fallback.

## Important Business Rules

* One vehicle should not be assigned to two active jobs at the same time.
* One driver should not have two active jobs unless the business allows it.
* Completing a job should free the vehicle.
* Cancelling a job should free the vehicle if assigned.
* Outlet staff should not edit completed jobs.
* Drivers should not edit jobs that are not assigned to them.
* Manager/admin should be able to fix mistakes if needed.
* Deleted data should be avoided where history is important. Prefer status changes instead of hard delete.

## Testing Checklist

Before finishing any change, check:

### Login and Roles

* Admin login works
* Manager login works
* Outlet login works
* Driver login works
* Each role sees only the correct screens

### Request Flow

* Outlet can create request
* Request appears for manager/admin
* Driver can accept assigned request
* Status changes correctly
* Vehicle becomes busy
* Driver can complete job
* Vehicle becomes available again

### Cancellation Flow

* Pending request can be cancelled
* Accepted request can be cancelled
* Vehicle status returns correctly
* Cancelled job is not shown as active

### Location Flow

* Driver can update location
* Manager/admin can see location
* Old location is handled clearly
* Wrong driver cannot update another driver's location

### Data Protection

* Company A cannot see Company B data
* Outlet cannot see admin-only data
* Driver cannot see unrelated jobs
* Service role key is not exposed

## Coding Style

Follow the existing style of the project.

General rules:

* Keep code readable
* Use meaningful variable names
* Add comments only for important logic
* Do not add unnecessary libraries
* Do not break existing working features
* Keep functions small where possible
* Avoid duplicate logic
* Validate important inputs
* Handle errors clearly for users

## Error Handling

Show simple user-friendly errors.

Good examples:

```
Could not create request. Please try again.
Vehicle is already busy.
Location permission is required to update your location.
You are not allowed to view this request.
```

Avoid showing technical database errors directly to normal users.

## Do Not Do

Do not:

* Expose Supabase service role key
* Disable security rules without asking
* Remove role protection
* Mix company data
* Delete important history
* Rewrite the full app without instruction
* Change database schema without explaining
* Rename columns casually
* Make the driver screen complicated
* Leave vehicles stuck as busy
* Fake location data
* Add payment features unless requested
* Add price/billing logic unless requested

## Preferred Way to Work

When asked to make changes:

1. First inspect the relevant files.
2. Understand the existing structure.
3. Make the smallest safe change.
4. Keep role permissions in mind.
5. Check vehicle/job status logic.
6. Explain what changed.
7. Mention any manual testing needed.

## Common Tasks Claude May Help With

Claude may help with:

* Fixing login issues
* Improving dashboard UI
* Creating Supabase tables
* Writing SQL policies
* Fixing vehicle status logic
* Adding location tracking
* Adding request/job history
* Improving mobile layout
* Creating admin/manager/driver/outlet views
* Debugging JavaScript
* Cleaning project structure
* Adding PWA support
* Improving security rules

## Future Feature Ideas

Possible future updates:

* Delivery proof photo
* Customer signature
* Driver notes
* Manager approval before assignment
* Vehicle maintenance mode
* Trip history report
* Daily vehicle usage report
* WhatsApp contact button
* Push notifications
* Low fuel / service reminder
* Driver attendance
* Multiple outlet support
* Live map view for manager

Do not add these unless the user asks.

## Project Priority

The highest priority is reliability.

The app should be:

1. Safe
2. Simple
3. Easy for staff
4. Correct with vehicle status
5. Protected by roles
6. Mobile-friendly
7. Easy to maintain

## Final Reminder

This project is for real shop/company operations.

Always protect business data, avoid breaking existing flows, and keep the app simple enough for daily staff use.
