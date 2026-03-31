/**
 * Map icon component using Maki + Temaki icon sets via CSS mask-image.
 * Icons from /icons/maki/ and /icons/temaki/ static assets (CC0 Public Domain).
 * Color inherits via currentColor — works with Tailwind text-* classes.
 *
 * MOTIS geocode categories map directly to Maki/Temaki icon names
 * (with underscore→hyphen conversion for Maki).
 */

/**
 * Mapping from MOTIS category (underscored) to the actual icon path.
 * Only needed for categories where the name doesn't match 1:1 with Maki/Temaki files.
 */
export const categoryOverrides: Record<string, string> = {
    none: "maki/marker",

    // Generic location types (not from MOTIS)
    station: "maki/rail",
    tram_stop: "maki/rail-light",
    bus_stop: "maki/bus",
    address: "maki/building",
    poi: "maki/marker",
    gps: "maki/marker",
    map: "maki/marker",
    coordinates: "maki/marker",
    place: "maki/marker",

    // -- Food & drink ---------------------------------------------------------
    pub: "maki/beer",
    biergarten: "maki/beer",
    outdoor_seating: "maki/cafe",

    // -- Culture & entertainment ----------------------------------------------
    artwork: "maki/art-gallery",
    community_centre: "maki/building",
    arts_centre: "maki/art-gallery",
    gallery: "maki/art-gallery",
    internet_cafe: "maki/cafe",
    public_bookcase: "maki/library",
    amusement_arcade: "maki/gaming",

    // -- Historic -------------------------------------------------------------
    memorial: "maki/monument",
    archaeological_site: "temaki/ruins",
    palace: "maki/castle",
    fortress: "maki/castle",
    historic_fort: "maki/castle",
    bust: "temaki/statue",
    city_gate: "temaki/gate",
    manor: "maki/lodging",
    stone: "temaki/cairn",
    carto_shrine: "maki/place-of-worship",

    // -- Leisure & sports -----------------------------------------------------
    fitness: "maki/fitness-centre",
    massage: "temaki/beauty_salon",
    sauna: "temaki/spa",
    public_bath: "maki/swimming",
    miniature_golf: "maki/golf",
    beach_resort: "maki/beach",
    fishing: "temaki/fishing_pier",
    leisure_dance: "maki/music",
    golf_icon: "maki/golf",
    leisure_golf_pin: "maki/golf",
    sports_centre: "maki/stadium",

    // -- Amenities & utilities ------------------------------------------------
    toilets: "maki/toilet",
    waste_disposal: "maki/waste-basket",
    camping: "maki/campsite",
    caravan: "temaki/camper_trailer",
    firepit: "temaki/campfire",
    bird_hide: "temaki/binoculars",
    table: "maki/picnic-site",
    excrement_bags: "temaki/vending_pet_waste",

    // -- Tourism & information ------------------------------------------------
    guidepost: "temaki/sign_and_pedestrian",
    board: "temaki/info_board",
    office: "maki/building",
    audioguide: "maki/information",

    // -- Accommodation --------------------------------------------------------
    hotel: "maki/lodging",
    tourism_guest_house: "maki/lodging",
    hostel: "maki/lodging",
    chalet: "temaki/cabin",
    motel: "maki/lodging",
    apartment: "maki/building",
    alpinehut: "temaki/hut",
    wilderness_hut: "temaki/hut",

    // -- Financial ------------------------------------------------------------
    bureau_de_change: "maki/bank",

    // -- Health ---------------------------------------------------------------
    doctors: "maki/doctor",

    // -- Education ------------------------------------------------------------
    kindergarten: "maki/school",
    university: "maki/college",

    // -- Post & communication -------------------------------------------------
    post_office: "maki/post",
    parcel_locker: "temaki/vending_lockers",

    // -- Transport ------------------------------------------------------------
    parking_subtle: "maki/parking",
    parking_bicycle: "maki/bicycle-share",
    rendering_railway_tram_stop_mapnik: "maki/rail-light",
    amenity_bus_station: "maki/bus",
    helipad: "maki/heliport",
    aerodrome: "maki/airport",
    rental_bicycle: "maki/bicycle-share",
    parking_tickets: "temaki/vending_tickets",
    subway_entrance: "maki/rail-metro",
    rental_car: "maki/car-rental",
    parking_entrance: "maki/parking-garage",
    public_transport_tickets: "temaki/vending_tickets",
    ferry_icon: "maki/ferry",
    parking_motorcycle: "temaki/motorcycle",
    bicycle_repair_station: "temaki/bicycle_repair",
    parking_entrance_multi_storey: "maki/parking-garage",
    transport_slipway: "maki/slipway",

    // -- Government & public services -----------------------------------------
    townhall: "maki/town-hall",
    diplomatic: "maki/embassy",
    office_diplomatic_consulate: "maki/embassy",
    social_amenity_darken: "temaki/social_facility",

    // -- Religion -------------------------------------------------------------
    christian: "maki/religious-christian",
    muslim: "maki/religious-muslim",
    jewish: "maki/religious-jewish",
    buddhist: "maki/religious-buddhist",
    taoist: "temaki/taoism",
    hinduist: "temaki/hinduism",
    shintoist: "temaki/shinto",
    sikhist: "temaki/sikhism",
    church: "maki/religious-christian",
    mosque: "maki/religious-muslim",
    synagogue: "maki/religious-jewish",

    // -- Shopping -------------------------------------------------------------
    supermarket: "maki/grocery",
    newsagent: "maki/shop",
    shop_other: "maki/shop",
    marketplace: "temaki/shopping_mall",
    clothes: "maki/clothing-store",
    doityourself: "temaki/tools",
    purple_car: "maki/car",
    beauty: "temaki/beauty_salon",
    butcher: "temaki/meat",
    alcohol: "maki/alcohol-shop",
    electronics: "temaki/electronic",
    shoes: "maki/shoe",
    car_parts: "temaki/car_structure",
    greengrocer: "temaki/food",
    jewellery: "maki/jewelry-store",
    jeweller: "maki/jewelry-store",
    books: "maki/library",
    department_store: "temaki/shopping_mall",
    variety_store: "maki/shop",
    travel_agency: "temaki/ticket",
    sports: "maki/shop",
    chemist: "maki/pharmacy",
    computer: "temaki/electronic",
    stationery: "maki/shop",
    pet: "temaki/pet_store",
    beverages: "maki/alcohol-shop",
    perfumery: "temaki/perfume",
    tyres: "maki/car-repair",
    shop_motorcycle: "temaki/motorcycle",
    copyshop: "temaki/toolbox",
    toys: "maki/shop",
    deli: "temaki/sandwich",
    tobacco: "maki/shop",
    seafood: "temaki/fish_cleaning",
    interior_decoration: "maki/furniture",
    photo: "maki/shop",
    trade: "maki/shop",
    outdoor: "maki/campsite",
    houseware: "maki/shop",
    art: "maki/art-gallery",
    fabric: "maki/shop",
    bookmaker: "maki/shop",
    second_hand: "maki/shop",
    charity: "maki/shop",
    bed: "maki/furniture",
    medical_supply: "maki/pharmacy",
    hifi: "temaki/speaker",
    shop_music: "maki/music",
    hearing_aids: "temaki/hearing_aid",
    musical_instrument: "maki/music",
    tea: "maki/cafe",
    video: "maki/shop",
    bag: "temaki/handbag",
    carpet: "maki/shop",
    video_games: "maki/gaming",
    vehicle_inspection: "maki/car-repair",
    dairy: "temaki/milk_jug",
    coffee: "maki/cafe",

    // -- Natural --------------------------------------------------------------
    tree: "temaki/tree_broadleaved",
    peak: "maki/mountain",
    spring: "maki/water",
    cave: "temaki/cliff_falling_rocks",

    // -- Infrastructure -------------------------------------------------------
    tower_freestanding: "temaki/tower",
    tower_observation: "maki/observation-tower",
    tower_bell_tower: "temaki/tower",
    hunting_stand: "temaki/hunting_blind",

    // -- Place types ----------------------------------------------------------
    hamlet: "maki/village",
    isolated_dwelling: "maki/home",
    allotments: "maki/garden",
    island: "temaki/island_trees_building",
    islet: "temaki/islet_tree",
    locality: "maki/town",
    suburb: "maki/city",
    neighbourhood: "maki/city",
    borough: "maki/city",
    quarter: "maki/city",

    // -- Misc -----------------------------------------------------------------
    food_court: "maki/restaurant",

    // -- OpenMapTiles POI class/subclass names ---------------------------------
    railway: "maki/rail",
    college: "maki/college",
    clothing_store: "maki/clothing-store",
    alcohol_shop: "maki/alcohol-shop",
    art_gallery: "maki/art-gallery",
    ice_cream: "maki/ice-cream",
    town_hall: "maki/town-hall",
    fast_food: "maki/fast-food",
    fire_station: "maki/fire-station",
    fitness_centre: "maki/fitness-centre",
    dog_park: "maki/dog-park",
    drinking_water: "maki/drinking-water",
    car_rental: "maki/car-rental",
    car_repair: "maki/car-repair",
    charging_station: "maki/charging-station",
    garden_centre: "maki/garden-centre",
    horse_riding: "maki/horse-riding",
    hot_spring: "maki/hot-spring",
    jewelry_store: "maki/jewelry-store",
    mobile_phone: "maki/mobile-phone",
    picnic_site: "maki/picnic-site",
    place_of_worship: "maki/place-of-worship",
    ranger_station: "maki/ranger-station",
    waste_basket: "maki/waste-basket",
    observation_tower: "maki/observation-tower",
    parking_garage: "maki/parking-garage",
    bowling_alley: "maki/bowling-alley",
    amusement_park: "maki/amusement-park",
    animal_shelter: "maki/animal-shelter",
    bicycle_share: "maki/bicycle-share",
    communications_tower: "maki/communications-tower",
};

/**
 * Resolve a category name to an icon URL path.
 * Tries in order: override map → Maki (hyphenated) → Temaki (underscored) → fallback.
 */
export function resolveIconPath(category: string): string {
    // Check overrides first
    const override = categoryOverrides[category];
    if (override) return `/icons/${override}.svg`;

    // Maki uses hyphens: fast_food → fast-food.svg
    const makiName = category.replace(/_/g, "-");
    // We can't check file existence at runtime, so we use a known-set approach.
    // Maki icons that MOTIS categories map to directly:
    if (knownMaki.has(makiName)) return `/icons/maki/${makiName}.svg`;

    // Temaki uses underscores (same as MOTIS)
    if (knownTemaki.has(category)) return `/icons/temaki/${category}.svg`;

    // Fallback
    return "/icons/maki/marker.svg";
}

// Auto-generated from public/icons/maki/*.svg
const knownMaki = new Set(["aerialway","airfield","airport","alcohol-shop","american-football","amusement-park","animal-shelter","aquarium","arrow","art-gallery","attraction","bakery","bank","bank-JP","bar","barrier","baseball","basketball","bbq","beach","beer","bicycle","bicycle-share","blood-bank","bowling-alley","bridge","building","building-alt1","bus","cafe","campsite","car","car-rental","car-repair","casino","castle","castle-JP","caution","cemetery","cemetery-JP","charging-station","cinema","circle","circle-stroked","city","clothing-store","college","college-JP","commercial","communications-tower","confectionery","construction","convenience","cricket","cross","dam","danger","defibrillator","dentist","diamond","doctor","dog-park","drinking-water","elevator","embassy","emergency-phone","entrance","entrance-alt1","farm","fast-food","fence","ferry","ferry-JP","fire-station","fire-station-JP","fitness-centre","florist","fuel","furniture","gaming","garden","garden-centre","gate","gift","globe","golf","grocery","hairdresser","harbor","hardware","heart","heliport","highway-rest-area","historic","home","horse-riding","hospital","hospital-JP","hot-spring","ice-cream","industry","information","jewelry-store","karaoke","landmark","landmark-JP","landuse","laundry","library","lift-gate","lighthouse","lighthouse-JP","lodging","logging","marae","marker","marker-stroked","mobile-phone","monument","monument-JP","mountain","museum","music","natural","nightclub","observation-tower","optician","paint","park","park-alt1","parking","parking-garage","parking-paid","pharmacy","picnic-site","pitch","place-of-worship","playground","police","police-JP","post","post-JP","prison","racetrack","racetrack-boat","racetrack-cycling","racetrack-horse","rail","rail-light","rail-metro","ranger-station","recycling","religious-buddhist","religious-christian","religious-jewish","religious-muslim","religious-shinto","residential-community","restaurant","restaurant-bbq","restaurant-noodle","restaurant-pizza","restaurant-seafood","restaurant-sushi","road-accident","roadblock","rocket","school","school-JP","scooter","shelter","shoe","shop","skateboard","skiing","slaughterhouse","slipway","snowmobile","soccer","square","square-stroked","stadium","star","star-stroked","suitcase","swimming","table-tennis","taxi","teahouse","telephone","tennis","terminal","theatre","toilet","toll","town","town-hall","triangle","triangle-stroked","tunnel","veterinary","viewpoint","village","volcano","volleyball","warehouse","waste-basket","watch","water","waterfall","watermill","wetland","wheelchair","windmill","zoo"]);

// Auto-generated from public/icons/temaki/*.svg
const knownTemaki = new Set(["abseiling","accessible_space","accounting","adit_profile","aerialway_pole","airport","amusement_park","anchor_medal","antenna","anvil","anvil_and_hammer","app_terminal","archery","army_tent","asterisk","atm","atm2","balance_beam","balloon","barn","beach","beauty_salon","bench","benchmark_disk","bicycle_box","bicycle_locker","bicycle_parked","bicycle_rental","bicycle_repair","bicycle_shed","bicycle_structure","bicycle_wash","bikini","billboard","binoculars","bleachers","blind","board_bus","board_ferry","board_gondola_lift","board_hanging_rail","board_heavy_rail","board_light_rail","board_monorail","board_school_bus","board_subway","board_train","board_train_bullet","board_train_diesel","board_train_kids","board_train_steam","board_tram","board_transit","board_trolleybus","boat","boat_dry_dock","boat_floating","boating","boat_ramp","boat_rental","boat_repair","boat_tour","bollard","bollard_row","book_store","bottles","boulder1","boulder2","boulder3","bow_and_arrow","bowling","bowling_alt1","bread","brick_trowel","bridge","briefcase","briefcase_asterisk","briefcase_bolt","briefcase_cross","briefcase_info","briefcase_shield","bubble_tea","buffer_stop","bulb","bulb2","bulb3","bulldozer","bulletin_board","bunk_beds","bunker","bunker_silo","buoy","bus","bus_guided","cabin","cable","cable_device","cable_manhole","cable_meter","cable_shutoff","cairn","camper_trailer","camper_trailer_dump","campfire","can","canoe","cape_landform","capitol","car_dealer","car_parked","car_pool","carport","car_structure","car_wash","casino","catering","cattle_grid","chairlift","checkpoint","chefs_knife","chicane_arrow","chimney","chocolate","cleaver","cliff_falling_rocks","climbing","clock","cloth","clothes_hanger","coffee","compass","conveyor","cooling_tower","cooling_tower_radiation","coral_reef","courthouse","crane","cross_country_skiing","crossing_markings-dashes","crossing_markings-dots","crossing_markings-ladder","crossing_markings-ladder_paired","crossing_markings-ladder_skewed","crossing_markings-lines","crossing_markings-lines_paired","crossing_markings-surface","crossing_markings-zebra","crossing_markings-zebra_bicolour","crossing_markings-zebra_double","crossing_markings-zebra_paired","crossing_rail_rail","crossing_rail_road","crossing_rail_solid","crossing_rail_striped","crossing_tram_road","crossing_tram_solid","crossing_tram_striped","curtains","cycle_barrier","cyclist_crosswalk","dagger","desk_lamp","detergent_bottle","diamond","dice","disc_golf_basket","diving","dog_shelter","domed_tower","donut","drag_lift","dress","drink_cup","ear","egg","electronic","elevator","embassy","fashion_accessories","ferry","field_hockey","fighter_jet","fire_hydrant","fire_hydrant_underground","fireplace","fish_cleaning","fishing_pier","fish_ladder","florist","food","footwear_decontamination","fountain","freight_car","furniture","garden_bed","gas","gas_device","gas_manhole","gas_meter","gas_shutoff","gate","golf_cart","golf_green","gondola_lift","goods_lift","gown","grapes","grass","guard_rail","gym","hair_care","hammer_shoe","hand","handbag","hangar","hang_gliding","hanging_rail","hearing_aid","heart","heavy_rail","hedge","height_restrictor","hinduism","horizontal_bar","horn_cleat","horse_shelter","horseshoe","horseshoes","hot_drink_cup","hotpot","houseboat","hunting_blind","hut","ice_fishing","ice_skating","info_board","inline_skating","island_trees_building","islet_tree","j_bar_lift","jetplane_front","jet_skiing","jewelry_store","junction","junk_car","kayaking","kerb-flush","kerb-lowered","kerb-raised","kerb-rolled","kerb-unspecified","kitchen_sink","latrine","laundry","lawn","lawyer","letter_box","library","lift_gate","light_rail","lipstick","lock","lounger","lounging","manhole","manufactured_home","mast","mast_communication","mast_lighting","maze","meat","milestone","military","military_checkpoint","milk_jug","mineshaft_cage","mineshaft_profile","money_hand","monorail","motorcycle","motorcycle_rental","motorcycle_repair","mountain_asterisk","mountain_cross","mountain_range","movie_rental","museum","natural_arch","needle_and_spool","obelisk","oil_well","os_benchmark","paifang","parking_space","passport_checkpoint","ped_cyclist_crosswalk","pedestrian","pedestrian_and_cyclist","pedestrian_crosswalk","pedestrian_walled","perfume","pet_grooming","pet_store","pharmacy","physiotherapist","pick_hammer","pickleball","picnic_shelter","pier_fixed","pier_floating","pin","pipe","planes","planes_bidirectional","plane_taxiing","plant","plaque","platter_lift","play_structure","plumber","police_checkpoint","police_officer","polished_nail","portrait","portrait_framed","post_box","poster_box","power","power_cb","power_cb2","power_circuit","power_ct","power_device","powered_pump","power_isolator","power_la","power_manhole","power_meter","power_pole","power_shutoff","power_switch","power_tower","power_transformer","propane_tank","psychic","quakerism","quay","racetrack_oval","radiation","radio","rafting","rail_flag","railing","rail_profile","railway_cable_track","railway_signals","railway_track","railway_track_askew","railway_track_mini","railway_track_narrow","railway_track_partial","real_estate_agency","rigging","rocket_firework","roller_coaster","room","rope_fence","row_houses","ruins","rumble_strip","saddle","sail","sailboat","sailing","sandbox","sandwich","scaffold","school","school_bus","scuba_diving","sculpture","security_camera","seesaw","shield","shinto","shopping_mall","shower","shrub","shrub_low","shuffleboard","sign_and_bench","sign_and_car","sign_and_pedestrian","sikhism","silo","skateboarding","skiing","ski_jumping","sledding","sleep_shelter","slide","snow","snowboarding","snowmobile","snow_shoeing","social_facility","spa","speaker","speed_bump","speed_dip","speed_dip_double","speed_hump","speed_table","speedway_8","speedway_oval","spice_bottle","spike_strip","spotting_scope","spring_rider","stamp","statue","stile_squeezer","stop","storage","storage_drum","storage_fermenter","storage_rental","storage_tank","street_lamp_arm","striped_way","striped_zone","subway","suitcase","suitcase_key","suitcase_xray","surfing","swamp","table_soccer","tall_gate","tanning","tanning2","taoism","tattoo_machine","taxi_stand","t_bar_lift","telephone","telescope","temaki","tennis","tents","ticket","tiling","tire","tire_course","toll_gantry","toolbox","tools","tower","tower_communication","town_hall","traffic_signals","train","train_bullet","train_diesel","train_kids","train_steam","train_wash","tram","tram_side","transit","transit_shelter","tree_and_bench","tree_broadleaved","tree_cactus","tree_leafless","tree_needleleaved","tree_palm","tree_row","tree_stump","trench","trolleybus","truck","tunnel","turnstile","utility_pole","vacuum","vacuum_station","valley","vase","vending_bread","vending_cigarettes","vending_cold_drink","vending_cold_drink2","vending_eggs","vending_flat_coin","vending_hot_drink","vending_hot_drink2","vending_ice","vending_ice_cream","vending_ice_cream2","vending_lockers","vending_love","vending_machine","vending_medicine","vending_newspaper","vending_pet_waste","vending_stamps","vending_tickets","vending_venus","vertex","vertical_rotisserie","veterinary_care","viewpoint","wall","waste","waste_device","waste_manhole","waste_meter","waste_shutoff","water","water_bottle","water_device","water_manhole","water_meter","water_shutoff","waterskiing","water_tap","water_tap_drinkable","water_tower","well_pump_manual","well_pump_powered","whale_watching","wheel","wheelchair","wheelchair_active","windmill","window","windpump","windsock","wind_surfing","wind_turbine","x_oblique","yield","zoo"]);

export function PinheadIcon({
    name,
    className = "h-4 w-4",
}: {
    /** Category/icon name (e.g. "restaurant", "cafe", "station", "address") */
    name: string;
    className?: string;
}) {
    const iconUrl = resolveIconPath(name);

    return (
        <span
            className={`inline-block shrink-0 ${className}`}
            role="img"
            style={{
                backgroundColor: "currentColor",
                WebkitMaskImage: `url(${iconUrl})`,
                maskImage: `url(${iconUrl})`,
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
            }}
        />
    );
}

/**
 * Get the icon name for a location type / MOTIS category.
 * The returned name can be passed directly to PinheadIcon.
 */
export function getPinheadIconName(type: string): string {
    return type;
}
