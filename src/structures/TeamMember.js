'use strict';

const Base = require('./Base');
const { MembershipStates } = require('../util/Constants');

/**
 * Represents a Client OAuth2 Application Team Member.
 * @extends {Base}
 */
class TeamMember extends Base {
  constructor(team, data) {
    super(team.client);

    /**
     * The Team this member is part of
     * @type {Team}
     */
    this.team = team;

    this._patch(data);
  }

  _patch(data) {
    if ('permissions' in data) {
      /**
       * The permissions this Team Member has with regard to the team
       * @type {string[]}
       * @deprecated Use {@link TeamMember#role} instead.
       */
      this.permissions = data.permissions;
    }

    if ('role' in data) {
      /**
       * The role of this Team Member
       * @type {TeamMemberRole}
       */
      this.role = data.role;
    }

    if ('membership_state' in data) {
      /**
       * The permissions this Team Member has with regard to the team
       * @type {MembershipState}
       */
      this.membershipState = MembershipStates[data.membership_state];
    }

    if ('user' in data) {
      /**
       * The user for this Team Member
       * @type {User}
       */
      this.user = this.client.users._add(data.user);
    }
  }

  /**
   * The Team Member's id
   * @type {Snowflake}
   * @readonly
   */
  get id() {
    return this.user.id;
  }

  /**
   * When concatenated with a string, this automatically returns the team member's mention instead of the
   * TeamMember object.
   * @returns {string}
   * @example
   * // Logs: Team Member's mention: <@123456789012345678>
   * console.log(`Team Member's mention: ${teamMember}`);
   */
  toString() {
    return this.user.toString();
  }
}

module.exports = TeamMember;
