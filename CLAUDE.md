# CLAUDE.md

## Project Name

Fleet Board Pro

## Project Overview

Fleet Board Pro is a **multi-tenant** vehicle location, delivery request, and fleet status management web app for shop/company operations. It is built to serve many companies on one platform, with every company's users and data strictly isolated (see **Platform Architecture** below).

The app helps outlets, managers, company admins, and drivers coordinate vehicle requests, track vehicle availability, and view driver/vehicle location updates.

The main purpose is to make vehicle movement clear, fast, and easy to manage.

## Core Goal

Build a simple, reliable system where:

1. Outlet/shop staff can request a vehicle.
2. Manager/admin can view and manage requests.
3. Driver can accept, start, update, and complete jobs.
4. Vehicle status updates automatically.
5. Manager/admin can see which vehicles are available, busy, or offline.
6. Driver location can be shown on the map when available.

## Platform Architecture

Fleet Board Pro is a multi-tenant fleet and dispatch management platform.

It is not built for only one company.

The platform can support many companies, and every company's users and data must remain strictly isolated using `company_id` and Row Level Security.

Hierarchy:

```
Fleet Board Pro Platform
└── Super Admin
    ├── Company A
    │   ├── Company Admins
    │   ├── Managers
    │   ├── Drivers
    │   ├── Vehicles
    │   └── Outlets
    ├── Company B
    │   └── Its own isolated users and data
    └── Additional companies
```

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

## Official Roles

### Super Admin

The Super Admin is the Fleet Board Pro platform owner.

This role is separate from every company.

Super Admin will eventually be able to:

* Create, suspend, reactivate, and manage companies
* Manage company access or subscription status
* Create or manage first company administrators through secure server-side functions
* View platform-wide totals and health information
* Delete or archive companies and their history through protected workflows
* Manage platform-level settings and feature access

Super Admin must never use a service_role key in frontend code.

Privileged operations such as creating Auth accounts, changing another user's password, or deleting a company must use secure Supabase Edge Functions or another protected backend.

The Super Admin feature is future work unless explicitly requested.

### Company Admin

The role currently stored internally as `admin` means Company Admin.

A Company Admin can manage only their own company.

Company Admin can:

* Create and manage outlets
* Create and manage driver records
* Create and manage vehicles
* Activate and deactivate company users
* Assign roles
* Link outlet accounts to outlets
* Link driver accounts to drivers and vehicles
* Manage company settings
* View company jobs, vehicle status, KM, fuel, service status, and reports

Company Admin cannot:

* View another company
* Create another company
* Manage platform subscriptions
* Access Super Admin functions

### Manager

Manager handles daily fleet operations for their company.

Manager can:

* Create manual jobs from any pickup and drop-off location
* Send open or specifically targeted requests
* Monitor vehicles and live locations
* Assign or override jobs
* View active jobs, history, KM, fuel, vehicle status, and reports
* Manage operational workflows allowed by company policy

Manager cannot access another company.

### Driver

Every driver has a separate login account and password.

A driver profile must be linked to:

* A driver record
* A company
* A vehicle before going On Duty

Rules:

* A driver without a linked vehicle cannot go On Duty
* A driver without a linked vehicle cannot receive open requests
* A driver without a linked vehicle cannot represent or share a vehicle's location
* On-duty drivers can receive open requests
* Specifically targeted requests may follow the approved targeted-dispatch rules
* Drivers can carry multiple active jobs
* Drivers only see their own assigned or claimable jobs
* Drivers only update their own duty, location, KM, and permitted fuel information

### Outlet

Every outlet/shop has its own separate login account and password.

An outlet account is linked to exactly one outlet record.

Outlet can:

* Create vehicle requests
* Send requests to any available driver or a specific available driver
* Track only vehicles handling its own active deliveries
* View its own request history and completion notifications

Outlet cannot:

* View other outlets' requests
* View all company vehicles
* View KM, fuel, service, or internal audit information
* Access another company

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

## Multi-Tenant Rules

* Every operational table must remain scoped by company_id where applicable.
* Company A must never see or edit Company B data.
* Frontend hiding is not security.
* Sensitive access must be enforced by Supabase RLS, database functions, triggers, and secure backend functions.
* Never weaken company separation for convenience.
* Every user account must have its own email/login and password.
* Do not share one login across multiple outlets, drivers, or managers.

## Vehicle Status Logic

Vehicle status is very important.

Expected vehicle statuses:

```
available
busy
offline
maintenance
service_due
in_service
damaged
```

Basic rules:

* When no active job exists, vehicle should be available.
* When a driver accepts or starts a job, vehicle should become busy.
* When job is completed, vehicle should return to available.
* When job is cancelled before starting, vehicle should return to available.
* When a vehicle is unavailable due to repair/service, use maintenance.
* When location has not updated for a long time, the app may show vehicle as offline.

Do not leave a vehicle stuck as busy after job completion or cancellation.

## Driver and Vehicle Rules

* A driver must be linked to a vehicle before going On Duty.
* Going On Duty should be blocked when no active vehicle is linked.
* The UI should show: "No vehicle assigned. Please contact your company admin."
* A vehicle may carry multiple active jobs.
* A vehicle remains busy while at least one accepted or in-progress job exists.
* A vehicle becomes available only after the last active job is completed or cancelled.
* Maintenance, In Service, and Damaged vehicles are not dispatchable.
* Service Due is advisory unless business rules later change.

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

## Security Rules

* Never expose Supabase service_role in frontend files.
* The browser may use only the public anon key.
* Super Admin and account-management operations requiring elevated privileges must use secure Edge Functions.
* Company Admin must never gain platform-wide access.
* Password changes:
  * Users may change their own password through Supabase Auth.
  * Changing another user's password requires a secure server-side operation.
* Prefer deactivate/archive over destructive deletion.
* Hard deletion of companies or history requires explicit confirmation and a protected backend workflow.

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

## Future Work Order

Keep these as future stages:

1. Daily Vehicle Reports and analytics
2. Super Admin / platform-owner system
3. Secure Auth-user creation and password-management Edge Functions
4. Remaining operational features
5. Final UI/UX redesign as the last stage

The final UI/UX redesign must remain last, after all main features and workflows are finished and tested.

## Final Reminder

This project is for real shop/company operations.

Always protect business data, avoid breaking existing flows, and keep the app simple enough for daily staff use.
