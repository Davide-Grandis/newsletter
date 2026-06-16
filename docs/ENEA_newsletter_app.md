# Newsletter Console

## Users & Authentication

* **Authentication is based on Cloudflare Access policy (Zero Trust)**  
  * Leverages the out-of-the-box Cloudflare native MFA (OTP email) and can be easily integrated in the future with any IdP without touching the application  
  * Based on an access control policy associated to a list of emails. The list supports up to 5K elements  
  * The app manages the policy and list objects automatically, no need to touch them from the dashboard   
  * Global settings: policy ID and list ID to allow the app to update them automatically when users are added/deleted.  
  * How it works: after authentication, the email address is passed to the application.


* **Two roles for users: super\_admin and admin**  
  * Super\_admin: full access to the application and global settings  
  * Admin: defined at newsletter level to manage and monitor one or more newsletters  
  * Many-to-many relationship between the admins and the newsletters tables (admins\_newsletters table)  
  * Each newsletter must have at least one admin \- cannot delete an admin if the only one for a given newsletter  
  * In case of conflict the super\_admin role wins  
  * The role is stored in the users table together with the email (key) and theme (light/dark) preference (defaults to light)


* **How it works**  
* After authentication, the app reads the email and finds a match in the users table  
  * If match, see the role and follow the role  
  * If no match, assume it’s super\_admin. Add in the table with role super\_admin and default theme setting.  
  * Admins only see the newsletters they are associated with and their properties.


* **Startup**

no need to add any user manually in the DB at startup. The only need at startup is to have one  
	super\_admin added in the Cloudflare access control policy.

* **Rules and settings:**  
* Super admins can create newsletters and must add at least one admin associated to them.  
* Super admins can add/deleted super admins and admins, for a given newsletter.   
* Global toggles to allow admins to create and delete newsletters (default OFF)  
* Global toggle to allow admins to edit/add admins (default OFF)  
* Any time a super\_admin is created or deleted, the Cloudflare users list must be updated.  
* Any time an admin is created or deleted, the admins\_newsletters table must be updated as well as the Cloudflare users list.

