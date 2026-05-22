-- ─────────────────────────────────────────────────────────────────────────────
-- Splash Meet Manager 11 — PostgreSQL schema (DDL version 20260101)
-- This DDL matches the schema used by the real Splash Meet Manager application.
-- Use this to create a fresh identical database for development or testing.
--
-- Key encoding conventions:
--   gender      smallint  1=Male  2=Female  3=Mixed/Open
--   round       smallint  1=Heats/Prelims  2=Semifinals  4=Finals  5=TimedFinals/DirectFinals
--                        (Splash MDB uses: 1=TimedFinal 2=Prelim 9=Final 11=Break — normalized on SMB restore)
--   racestatus  smallint  0=empty  4=seeded/assigned  5=validated/official  8+=completed
--   resultstatus smallint NULL/0=normal  1=DNS  2=DNF  3=DSQ
--   course      smallint  1=50m(LCM)  2=25yd(SCY)  3=25m(SCM)
--   boolean     char(1)   'T'=true  'F'=false
--   times       integer   milliseconds (e.g. 60500 = 1:00.50)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Lookup / reference tables ───────────────────────────────────────────────

CREATE TABLE swimstyle (
  swimstyleid   INTEGER NOT NULL,
  code          VARCHAR(10),
  distance      SMALLINT,
  name          VARCHAR(50),
  relaycount    SMALLINT,
  stroke        SMALLINT,         -- 1=Free 2=Back 3=Breast 4=Fly 5=IM 6=FreeRelay 7=MedRelay
  sortcode      INTEGER,
  technique     SMALLINT,
  uniqueid      SMALLINT,
  CONSTRAINT pk_swimstyle PRIMARY KEY (swimstyleid)
);

CREATE TABLE dsqitem (
  dsqitemid     INTEGER NOT NULL,
  code          VARCHAR(10),
  lenexcode     VARCHAR(10),
  name          VARCHAR(250),
  options       VARCHAR(5),
  sortcode      SMALLINT,
  CONSTRAINT pk_dsqitem PRIMARY KEY (dsqitemid)
);

CREATE TABLE bsglobal (
  name          VARCHAR(50) NOT NULL DEFAULT '',
  data          TEXT,
  CONSTRAINT pk_bsglobal PRIMARY KEY (name)
);

-- ─── Club / Athlete ───────────────────────────────────────────────────────────

CREATE TABLE club (
  clubid             INTEGER NOT NULL,
  code               VARCHAR(10),
  name               VARCHAR(80),
  nameen             VARCHAR(80),
  shortname          VARCHAR(30),
  shortnameen        VARCHAR(30),
  nation             VARCHAR(3),
  region             VARCHAR(10),
  longcode           VARCHAR(20),
  clubtype           SMALLINT,
  teamnumber         SMALLINT,
  entryclubid        INTEGER,
  entryemails        VARCHAR(255),
  bonuspoints        INTEGER,
  swrid              INTEGER,
  externalid         VARCHAR(40),
  contactname        VARCHAR(50),
  contactinternet    VARCHAR(150),
  contactcity        VARCHAR(30),
  contactcountry     VARCHAR(2),
  contactemail       VARCHAR(50),
  contactfax         VARCHAR(20),
  contactphone       VARCHAR(20),
  contactstate       VARCHAR(5),
  contactstreet      VARCHAR(50),
  contactstreet2     VARCHAR(50),
  contactzip         VARCHAR(10),
  CONSTRAINT pk_club PRIMARY KEY (clubid)
);

CREATE TABLE athlete (
  athleteid          INTEGER NOT NULL,
  clubid             INTEGER REFERENCES club(clubid),
  firstname          VARCHAR(30),
  firstname_upper    VARCHAR(5),
  gender             SMALLINT,    -- 1=M 2=F
  lastname           VARCHAR(50),
  lastname_upper     VARCHAR(10),
  nameprefix         VARCHAR(20),
  birthdate          TIMESTAMP WITHOUT TIME ZONE,
  domicile           VARCHAR(50),
  externalid         VARCHAR(40),
  firstnameen        VARCHAR(30),
  handicapex         VARCHAR(20),
  handicaps          SMALLINT,
  handicapsb         SMALLINT,
  handicapsm         SMALLINT,
  lastnameen         VARCHAR(50),
  license            VARCHAR(20),
  nation             VARCHAR(3),
  sdmsid             INTEGER,
  status             INTEGER,
  swimlevel          VARCHAR(10),
  swrid              INTEGER,
  swrhashkey         INTEGER,
  clubcode2          VARCHAR(10),
  coachname          VARCHAR(80),
  schoolyear         VARCHAR(10),
  middlename         VARCHAR(50),
  middlenameen       VARCHAR(50),
  CONSTRAINT pk_athlete PRIMARY KEY (athleteid)
);

CREATE INDEX ix_athlete_club      ON athlete (clubid);
CREATE INDEX ix_athlete_firstname ON athlete (firstname_upper);
CREATE INDEX ix_athlete_lastname  ON athlete (lastname_upper);

CREATE TABLE biography (
  biographyid    INTEGER NOT NULL,
  xmldata        TEXT,
  imageformat    SMALLINT,
  picture        BYTEA,
  CONSTRAINT pk_biography PRIMARY KEY (biographyid)
);

CREATE TABLE official (
  officialid         INTEGER NOT NULL,
  clubid             INTEGER REFERENCES club(clubid),
  firstname          VARCHAR(30),
  firstname_upper    VARCHAR(5),
  gender             SMALLINT,
  lastname           VARCHAR(50),
  lastname_upper     VARCHAR(10),
  nameprefix         VARCHAR(20),
  grade              VARCHAR(20),
  license            VARCHAR(20),
  nation             VARCHAR(3),
  contactcity        VARCHAR(30),
  contactcountry     VARCHAR(2),
  contactemail       VARCHAR(50),
  contactfax         VARCHAR(20),
  contactphone       VARCHAR(20),
  contactstate       VARCHAR(5),
  contactstreet      VARCHAR(50),
  contactstreet2     VARCHAR(50),
  contactzip         VARCHAR(10),
  CONSTRAINT pk_official PRIMARY KEY (officialid)
);

CREATE INDEX ix_official_club ON official (clubid);

CREATE TABLE coach (
  coachid            INTEGER NOT NULL,
  clubid             INTEGER,
  firstname          VARCHAR(30),
  firstname_upper    VARCHAR(5),
  gender             SMALLINT,
  lastname           VARCHAR(50),
  lastname_upper     VARCHAR(10),
  nameprefix         VARCHAR(20),
  license            VARCHAR(20),
  nation             VARCHAR(3),
  coachtype          SMALLINT,
  contactcity        VARCHAR(30),
  contactcountry     VARCHAR(2),
  contactemail       VARCHAR(50),
  contactfax         VARCHAR(20),
  contactphone       VARCHAR(20),
  contactstate       VARCHAR(5),
  contactstreet      VARCHAR(50),
  contactstreet2     VARCHAR(50),
  contactzip         VARCHAR(10),
  CONSTRAINT pk_coach PRIMARY KEY (coachid)
);

-- ─── Session / Event ──────────────────────────────────────────────────────────

CREATE TABLE swimsession (
  swimsessionid          INTEGER NOT NULL,
  sessionnumber          SMALLINT,
  name                   VARCHAR(100),
  daytime                TIMESTAMP WITHOUT TIME ZONE,
  endtime                TIMESTAMP WITHOUT TIME ZONE,
  startdate              TIMESTAMP WITHOUT TIME ZONE,
  course                 SMALLINT,   -- 1=50m 2=25yd 3=25m
  lanemin                SMALLINT,
  lanemax                SMALLINT,
  lanesbyplace           VARCHAR(100),
  poolglobal             CHAR(1) DEFAULT 'F' CHECK (poolglobal IN ('F','T')),
  pooltype               SMALLINT,
  timing                 SMALLINT,
  touchpadmode           SMALLINT,
  roundtotenths          CHAR(1) DEFAULT 'F' CHECK (roundtotenths IN ('F','T')),
  following              CHAR(1) DEFAULT 'F' CHECK (following IN ('F','T')),
  feeathlete             DOUBLE PRECISION,
  maxentriesathlete      SMALLINT,
  maxentriesrelay        SMALLINT,
  officialmeeting        TIMESTAMP WITHOUT TIME ZONE,
  tlmeeting              TIMESTAMP WITHOUT TIME ZONE,
  warmupfrom             TIMESTAMP WITHOUT TIME ZONE,
  warmupuntil            TIMESTAMP WITHOUT TIME ZONE,
  remarks                TEXT,
  remarksjury            TEXT,
  CONSTRAINT pk_swimsession PRIMARY KEY (swimsessionid)
);

CREATE TABLE swimevent (
  swimeventid            INTEGER NOT NULL,
  swimsessionid          INTEGER REFERENCES swimsession(swimsessionid) ON DELETE CASCADE,
  swimstyleid            INTEGER REFERENCES swimstyle(swimstyleid),
  eventnumber            SMALLINT,
  gender                 SMALLINT,   -- 1=M 2=F 3=Mixed
  round                  SMALLINT,   -- 1=PRE 2=SEM 4=FIN 5=TIM
  roundname              VARCHAR(50),
  sortcode               INTEGER,
  daytime                TIMESTAMP WITHOUT TIME ZONE,
  duration               TIMESTAMP WITHOUT TIME ZONE,
  preveventid            INTEGER,    -- prelim→final link
  finalorder             SMALLINT,
  entrytimeconversion    SMALLINT,
  entrytimepercent       SMALLINT,
  fee                    DOUBLE PRECISION,
  lanemax                SMALLINT,
  maxentries             SMALLINT,
  qualbyplace            SMALLINT,
  singleheats            SMALLINT,
  externalid             VARCHAR(40),
  comment                TEXT,
  sponsor                VARCHAR(50),
  masters                CHAR(1) DEFAULT 'F' CHECK (masters IN ('F','T')),
  pfineignore            CHAR(1) DEFAULT 'F' CHECK (pfineignore IN ('F','T')),
  seedbonuslast          CHAR(1) DEFAULT 'F' CHECK (seedbonuslast IN ('F','T')),
  seedexhlast            CHAR(1) DEFAULT 'F' CHECK (seedexhlast IN ('F','T')),
  seedlateentrylast      CHAR(1) DEFAULT 'F' CHECK (seedlateentrylast IN ('F','T')),
  seedingglobal          CHAR(1) DEFAULT 'F' CHECK (seedingglobal IN ('F','T')),
  splashmecanedit        CHAR(1) DEFAULT 'F' CHECK (splashmecanedit IN ('F','T')),
  twoperlane             CHAR(1) DEFAULT 'F' CHECK (twoperlane IN ('F','T')),
  combineagegroups       CHAR(1) DEFAULT 'F' CHECK (combineagegroups IN ('F','T')),
  internalevent          CHAR(1) DEFAULT 'F' CHECK (internalevent IN ('F','T')),
  roundone               VARCHAR(20),
  lytentrylist           INTEGER,
  lytstartlist           INTEGER,
  lytresult2column       INTEGER,
  lytresult2split        INTEGER,
  lytresult4split        INTEGER,
  lytresultnosplit       INTEGER,
  lytresulthtml          INTEGER,
  CONSTRAINT pk_swimevent PRIMARY KEY (swimeventid)
);

CREATE INDEX ix_swimevent_swimsession ON swimevent (swimsessionid);
CREATE INDEX ix_swimevent_swimstyle   ON swimevent (swimstyleid);

CREATE TABLE agegroup (
  agegroupid             INTEGER NOT NULL,
  swimeventid            INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
  name                   VARCHAR(50),
  code                   VARCHAR(10),
  agemin                 SMALLINT,
  agemax                 SMALLINT,
  agemin2                SMALLINT,
  agemax2                SMALLINT,
  agebytotal             CHAR(1) DEFAULT 'F' CHECK (agebytotal IN ('F','T')),
  gender                 SMALLINT,
  heatcount              SMALLINT,
  fastheatcount          SMALLINT,
  resultcount            SMALLINT,
  sortcode               INTEGER,
  externalid             VARCHAR(40),
  useformedals           CHAR(1) DEFAULT 'F' CHECK (useformedals IN ('F','T')),
  useforscoring          CHAR(1) DEFAULT 'F' CHECK (useforscoring IN ('F','T')),
  allofficial            CHAR(1) DEFAULT 'F' CHECK (allofficial IN ('F','T')),
  forceprelim            CHAR(1) DEFAULT 'F' CHECK (forceprelim IN ('F','T')),
  seedwithtsonly         CHAR(1) DEFAULT 'F' CHECK (seedwithtsonly IN ('F','T')),
  athletestatuses        INTEGER,
  clubids                VARCHAR(1024),
  handicaps              VARCHAR(100),
  heatqualipriority      VARCHAR(50),
  levelmax               VARCHAR(5),
  levelmin               VARCHAR(5),
  nationality            VARCHAR(3),
  nationregions          VARCHAR(1024),
  scoretype              SMALLINT,
  swimlevels             VARCHAR(255),
  winnertitle            VARCHAR(100),
  foreigncount           SMALLINT,
  finalseedtype          SMALLINT,
  CONSTRAINT pk_agegroup PRIMARY KEY (agegroupid)
);

CREATE INDEX ix_agegroup_swimevent ON agegroup (swimeventid);

CREATE TABLE heat (
  heatid                 INTEGER NOT NULL,
  swimeventid            INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
  agegroupid             INTEGER,
  agegrouporder          INTEGER,
  heatnumber             SMALLINT,
  name                   VARCHAR(50),
  racestatus             SMALLINT,   -- 0=empty 4=seeded 8+=completed
  sortcode               INTEGER,
  daytime                TIMESTAMP WITHOUT TIME ZONE,
  finalcode              VARCHAR(2),
  remarks                TEXT,
  seedeventid            INTEGER,
  code                   VARCHAR(10),
  reservecount           SMALLINT,
  foreigncount           SMALLINT,
  CONSTRAINT pk_heat PRIMARY KEY (heatid)
);

CREATE INDEX ix_heat_swimevent ON heat (swimeventid);

CREATE TABLE judge (
  judgeid                INTEGER NOT NULL,
  swimsessionid          INTEGER REFERENCES swimsession(swimsessionid) ON DELETE CASCADE,
  officialid             INTEGER REFERENCES official(officialid),
  judgenumber            SMALLINT,
  judgerole              SMALLINT,
  sortcode               INTEGER,
  remarks                VARCHAR(100),
  CONSTRAINT pk_judge PRIMARY KEY (judgeid)
);

CREATE INDEX ix_judge_official    ON judge (officialid);
CREATE INDEX ix_judge_swimsession ON judge (swimsessionid);

-- ─── Results ──────────────────────────────────────────────────────────────────

CREATE TABLE swimresult (
  -- Combined entry + result row (LENEX model)
  swimresultid           INTEGER NOT NULL,
  athleteid              INTEGER REFERENCES athlete(athleteid) ON DELETE CASCADE,
  swimeventid            INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
  agegroupid             INTEGER,    -- which age group this entry belongs to
  heatid                 INTEGER,    -- assigned heat (NULL = unseeded)
  lane                   SMALLINT,   -- assigned lane
  entrytime              INTEGER,    -- seed time in ms (NULL = NT)
  entrycourse            SMALLINT,
  swimtime               INTEGER,    -- result time in ms (NULL if DNS/DNF/no result)
  reactiontime           SMALLINT,   -- reaction time in ms
  resultstatus           SMALLINT,   -- NULL/0=normal  1=DNS  2=DNF  3=DSQ
  dsqitemid              INTEGER,
  dsqdaytime             TIMESTAMP WITHOUT TIME ZONE,
  dsqnotified            CHAR(1) DEFAULT 'F' CHECK (dsqnotified IN ('F','T')),
  dsqnumber              SMALLINT,
  dsqofficialid          INTEGER,
  padtime                INTEGER,    -- touchpad time in ms
  backuptime1            INTEGER,
  backuptime2            INTEGER,
  backuptime3            INTEGER,
  usetimetype            SMALLINT,   -- 0=manual 1=touchpad/timing
  qualcode               VARCHAR(2),
  infocode               VARCHAR(5),
  reservecode            VARCHAR(20),
  comment                VARCHAR(250),
  mpoints                SMALLINT,
  finalfix               CHAR(1) DEFAULT 'F' CHECK (finalfix IN ('F','T')),
  lateentry              CHAR(1) DEFAULT 'F' CHECK (lateentry IN ('F','T')),
  bonusentry             CHAR(1) DEFAULT 'F' CHECK (bonusentry IN ('F','T')),
  noadvance              CHAR(1) DEFAULT 'F' CHECK (noadvance IN ('F','T')),
  finishjudge            SMALLINT,
  officialsplits         VARCHAR(100),
  qttiming               SMALLINT,
  qttime                 INTEGER,
  qtdate                 TIMESTAMP WITHOUT TIME ZONE,
  qtcity                 VARCHAR(30),
  qtname                 VARCHAR(100),
  qtnation               VARCHAR(3),
  qtcourse               SMALLINT,
  swrabestid             INTEGER,
  swrabesttime           INTEGER,
  swrsbestid             INTEGER,
  swrsbesttime           INTEGER,
  CONSTRAINT pk_swimresult PRIMARY KEY (swimresultid)
);

CREATE INDEX ix_swimresult_athlete   ON swimresult (athleteid);
CREATE INDEX ix_swimresult_swimevent ON swimresult (swimeventid);

CREATE TABLE split (
  swimresultid  INTEGER NOT NULL REFERENCES swimresult(swimresultid) ON DELETE CASCADE,
  distance      SMALLINT NOT NULL,
  swimtime      INTEGER,           -- cumulative time in ms at this distance
  CONSTRAINT pk_split PRIMARY KEY (swimresultid, distance)
);

-- ─── Relay ────────────────────────────────────────────────────────────────────

CREATE TABLE relay (
  relayid      INTEGER NOT NULL,
  clubid       INTEGER REFERENCES club(clubid),
  swimeventid  INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
  agegroupid   INTEGER,
  heatid       INTEGER,
  lane         SMALLINT,
  name         VARCHAR(100),
  gender       SMALLINT,
  athletes     INTEGER,
  relaycode    INTEGER,
  teamnumber   SMALLINT,
  agemin       SMALLINT,
  agemax       SMALLINT,
  agetotal     SMALLINT,
  entrytime    INTEGER,
  entrycourse  SMALLINT,
  swimtime     INTEGER,
  reactiontime SMALLINT,
  resultstatus SMALLINT,
  dsqitemid    INTEGER,
  dsqdaytime   TIMESTAMP WITHOUT TIME ZONE,
  dsqnotified  CHAR(1) DEFAULT 'F',
  dsqnumber    SMALLINT,
  dsqofficialid INTEGER,
  padtime      INTEGER,
  backuptime1  INTEGER,
  backuptime2  INTEGER,
  backuptime3  INTEGER,
  usetimetype  SMALLINT,
  qualcode     VARCHAR(2),
  infocode     VARCHAR(5),
  reservecode  VARCHAR(20),
  comment      VARCHAR(250),
  mpoints      SMALLINT,
  finalfix     CHAR(1) DEFAULT 'F',
  lateentry    CHAR(1) DEFAULT 'F',
  bonusentry   CHAR(1) DEFAULT 'F',
  noadvance    CHAR(1) DEFAULT 'F',
  finishjudge  SMALLINT,
  officialsplits VARCHAR(100),
  qttiming     SMALLINT,
  qttime       INTEGER,
  qtdate       TIMESTAMP WITHOUT TIME ZONE,
  qtcity       VARCHAR(30),
  qtname       VARCHAR(100),
  qtnation     VARCHAR(3),
  qtcourse     SMALLINT,
  CONSTRAINT pk_relay PRIMARY KEY (relayid)
);

CREATE INDEX ix_relay_club      ON relay (clubid);
CREATE INDEX ix_relay_swimevent ON relay (swimeventid);

CREATE TABLE relayposition (
  relayid      INTEGER REFERENCES relay(relayid) ON DELETE CASCADE,
  relaynumber  SMALLINT,
  athleteid    INTEGER REFERENCES athlete(athleteid),
  reactiontime SMALLINT,
  resultstatus SMALLINT,
  qttiming     SMALLINT,
  qttime       INTEGER,
  qtdate       TIMESTAMP WITHOUT TIME ZONE,
  qtcity       VARCHAR(30),
  qtname       VARCHAR(100),
  qtnation     VARCHAR(3),
  qtcourse     SMALLINT,
  qtislap      CHAR(1) DEFAULT 'F'
);

CREATE INDEX ix_relayposition_athlete ON relayposition (athleteid);
CREATE INDEX ix_relayposition_relay   ON relayposition (relayid);

CREATE TABLE relaysplit (
  relayid   INTEGER NOT NULL REFERENCES relay(relayid) ON DELETE CASCADE,
  distance  SMALLINT NOT NULL,
  swimtime  INTEGER,
  CONSTRAINT pk_relaysplit PRIMARY KEY (relayid, distance)
);

-- ─── Records ──────────────────────────────────────────────────────────────────

CREATE TABLE recordagegroup (
  recordagegroupid INTEGER NOT NULL,
  agemin           SMALLINT,
  agemax           SMALLINT,
  agetype          SMALLINT,
  CONSTRAINT pk_recordagegroup PRIMARY KEY (recordagegroupid)
);

CREATE TABLE recordlist (
  recordlistid   INTEGER NOT NULL,
  name           VARCHAR(100),
  shortname      VARCHAR(40),
  code           VARCHAR(20),
  lenexcode      VARCHAR(20),
  splashmecode   VARCHAR(10),
  nationregion   VARCHAR(20),
  agegroups      VARCHAR(255),
  sortcode       INTEGER,
  updatemode     SMALLINT,
  agecacltype    SMALLINT,
  CONSTRAINT pk_recordlist PRIMARY KEY (recordlistid)
);

CREATE TABLE recordlistagegroup (
  recordlistid     INTEGER REFERENCES recordlist(recordlistid) ON DELETE CASCADE,
  recordagegroupid INTEGER REFERENCES recordagegroup(recordagegroupid) ON DELETE CASCADE
);

CREATE INDEX ix_rlagegroup_agegroup   ON recordlistagegroup (recordagegroupid);
CREATE INDEX ix_rlagegroup_recordlist ON recordlistagegroup (recordlistid);

CREATE TABLE record (
  recordid         INTEGER NOT NULL,
  recordlistid     INTEGER REFERENCES recordlist(recordlistid) ON DELETE CASCADE,
  recordagegroupid INTEGER REFERENCES recordagegroup(recordagegroupid) ON DELETE CASCADE,
  swimstyleid      INTEGER REFERENCES swimstyle(swimstyleid),
  swimeventid      INTEGER,
  resultid         INTEGER,
  agegroup         INTEGER,
  birthdate        TIMESTAMP WITHOUT TIME ZONE,
  clubcode         VARCHAR(10),
  clubname         VARCHAR(80),
  clubnation       VARCHAR(3),
  course           SMALLINT,
  firstname        VARCHAR(30),
  gender           SMALLINT,
  handicap         SMALLINT,
  lastname         VARCHAR(50),
  meetcity         VARCHAR(30),
  meetdate         TIMESTAMP WITHOUT TIME ZONE,
  meetname         VARCHAR(100),
  meetnation       VARCHAR(3),
  nameprefix       VARCHAR(20),
  swimtime         INTEGER,
  CONSTRAINT pk_record PRIMARY KEY (recordid)
);

CREATE INDEX ix_record_agegroup             ON record (recordagegroupid);
CREATE INDEX ix_record_recordlist_swimstyle ON record (recordlistid, swimstyleid, course);
CREATE INDEX ix_record_swimstyle            ON record (swimstyleid);

CREATE TABLE recordposition (
  recordid     INTEGER REFERENCES record(recordid) ON DELETE CASCADE,
  relaynumber  SMALLINT,
  birthdate    TIMESTAMP WITHOUT TIME ZONE,
  firstname    VARCHAR(30),
  gender       SMALLINT,
  lastname     VARCHAR(50),
  nameprefix   VARCHAR(20)
);

CREATE INDEX ix_recordposition_record ON recordposition (recordid);

CREATE TABLE recordsplit (
  recordid  INTEGER NOT NULL REFERENCES record(recordid) ON DELETE CASCADE,
  distance  SMALLINT NOT NULL,
  swimtime  INTEGER,
  CONSTRAINT pk_recordsplit PRIMARY KEY (recordid, distance)
);

-- ─── Eventrecord ──────────────────────────────────────────────────────────────

CREATE TABLE eventrecord (
  eventrecordid INTEGER NOT NULL,
  swimeventid   INTEGER REFERENCES swimevent(swimeventid) ON DELETE CASCADE,
  listid        INTEGER,
  comment       VARCHAR(50),
  fine          DOUBLE PRECISION,
  marker        VARCHAR(8),
  onresultlist  CHAR(1) DEFAULT 'F' CHECK (onresultlist IN ('F','T')),
  onstartlist   CHAR(1) DEFAULT 'F' CHECK (onstartlist IN ('F','T')),
  sortcode      INTEGER,
  CONSTRAINT pk_eventrecord PRIMARY KEY (eventrecordid)
);

CREATE INDEX ix_eventrecord_swimevent ON eventrecord (swimeventid);

-- ─── Result placement / points ────────────────────────────────────────────────

CREATE TABLE resultplace (
  agegroupid  INTEGER NOT NULL REFERENCES agegroup(agegroupid) ON DELETE CASCADE,
  sortcode    SMALLINT NOT NULL,
  resultid    INTEGER,
  fjeffective SMALLINT,
  place       SMALLINT,
  CONSTRAINT pk_resultplace PRIMARY KEY (agegroupid, sortcode)
);

CREATE TABLE resultpointscore (
  resultid     INTEGER,
  pointscoreid INTEGER
);

-- ─── Time standards ───────────────────────────────────────────────────────────

CREATE TABLE timestandardlist (
  timestandardlistid INTEGER NOT NULL,
  name               VARCHAR(50),
  code               VARCHAR(5),
  course             SMALLINT,
  gender             SMALLINT,
  handicap           SMALLINT,
  nation             VARCHAR(3),
  standardtype       SMALLINT,
  tslgroup           INTEGER,
  agemin             SMALLINT,
  agemax             SMALLINT,
  CONSTRAINT pk_timestandardlist PRIMARY KEY (timestandardlistid)
);

CREATE TABLE timestandard (
  timestandardlistid INTEGER NOT NULL REFERENCES timestandardlist(timestandardlistid) ON DELETE CASCADE,
  swimstyleid        INTEGER NOT NULL REFERENCES swimstyle(swimstyleid),
  swimtime           INTEGER,
  CONSTRAINT pk_timestandard PRIMARY KEY (timestandardlistid, swimstyleid)
);

CREATE INDEX ix_timestandard_swimstyle ON timestandard (swimstyleid);

-- ─── Timing raw data ──────────────────────────────────────────────────────────

CREATE TABLE timingdata (
  timingdataid    INTEGER NOT NULL,
  swimsessionid   INTEGER REFERENCES swimsession(swimsessionid) ON DELETE CASCADE,
  datatype        SMALLINT,
  dnsbits         VARCHAR(3),
  eventnumber     SMALLINT,
  eventnumberex   VARCHAR(8),
  heatid          SMALLINT,
  heatnumber      SMALLINT,
  heatnumberex    SMALLINT,
  instancenumber  SMALLINT,
  lane            SMALLINT,
  lap             SMALLINT,
  modified        TIMESTAMP WITHOUT TIME ZONE,
  place           SMALLINT,
  swimtime        INTEGER,
  CONSTRAINT pk_timingdata PRIMARY KEY (timingdataid)
);

CREATE INDEX ix_timingdata_swimsession ON timingdata (swimsessionid);

-- ─── SplashMe / messaging ─────────────────────────────────────────────────────

CREATE TABLE splashmemessage (
  splashmemessageid INTEGER NOT NULL DEFAULT nextval('splashmemessage_seq'),
  data              TEXT,
  destination       INTEGER,
  email             VARCHAR(60),
  handled           CHAR(1) DEFAULT 'F' CHECK (handled IN ('F','T')),
  modified          TIMESTAMP WITHOUT TIME ZONE,
  typ               SMALLINT,
  swrid             INTEGER,
  CONSTRAINT pk_splashmemessage PRIMARY KEY (splashmemessageid)
);

CREATE INDEX ix_splashmemessage_modified ON splashmemessage (modified DESC);
CREATE INDEX ix_splashmemessage_swrid    ON splashmemessage (swrid);

CREATE TABLE bsmessage (
  bsmessageid INTEGER NOT NULL DEFAULT nextval('bsmessage_seq'),
  created     TIMESTAMP WITHOUT TIME ZONE,
  data        VARCHAR(2048),
  CONSTRAINT bsmessage_pkey PRIMARY KEY (bsmessageid)
);

CREATE TABLE bspicture (
  bspictureid INTEGER NOT NULL,
  code        VARCHAR(100),
  comment     VARCHAR(255),
  imageformat INTEGER,
  picture     BYTEA,
  height      INTEGER,
  width       INTEGER,
  CONSTRAINT pk_bspicture PRIMARY KEY (bspictureid)
);

CREATE TABLE bsswkatalogitem (
  bsswkatalogitemid INTEGER NOT NULL,
  code              VARCHAR(10),
  itemid            SMALLINT,
  katalogid         INTEGER,
  lenexcode         VARCHAR(10),
  name              VARCHAR(250),
  sortcode          SMALLINT,
  CONSTRAINT pk_bsswkatalogitem PRIMARY KEY (bsswkatalogitemid)
);

CREATE INDEX ix_bsswkatalogitem_katalog ON bsswkatalogitem (katalogid, itemid);
